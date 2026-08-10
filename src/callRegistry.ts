import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, verifyAppToken, verifyStreamToken } from './auth.js';
import {
  base64ToPcm16,
  base64ToBytes,
  bytesToBase64,
  makeDtmfMuLaw8kBase64,
  openAiPcm24kBase64ToTwilioMuLaw8kBase64,
  twilioMuLaw8kBase64ToOpenAiPcm24kBase64
} from './audio/codec.js';
import { createSpeechPcm24kBase64 } from './openai/speech.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import { PredictiveReservationController } from './predictive/reservationController.js';
import { completeTwilioCall } from './twilio/client.js';
import type { AppClientMessage, AppServerMessage, CreateCallRequest, PredictiveMode, TwilioMediaMessage } from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;
const MAX_TRANSCRIPT_DIAGNOSTIC_TAIL = 200;
const SPEECH_RMS_THRESHOLD = 0.003;
const OUTPUT_SPEECH_HANGOVER_MS = 9000;
const REMOTE_MEDIA_OUTPUT_HANGOVER_MS = 45000;

type DiagnosticTranscriptEntry = {
  at: string;
  speaker: 'owner' | 'remote';
  kind: 'source' | 'translation';
  delta: string;
};

export interface CallRecord {
  callId: string;
  callSid: string | null;
  to: string;
  userLanguage: string;
  remoteLanguage: string;
  announceTranslationAtStart: boolean;
  introMessageText?: string;
  introDisclaimerText?: string;
  predictiveMode: PredictiveMode;
  createdAt: string;
  state: 'created' | 'calling' | 'twilio-connected' | 'live' | 'ended' | 'error';
  error?: string;
  appToken: string;
  twilioStreamSid?: string;
  lastActivityAt?: string;
  transcripts: DiagnosticTranscriptEntry[];
  counters: {
    appAudioChunks: number;
    twilioMediaChunks: number;
    twilioOutboundEchoChunksDropped: number;
    appSilentChunksDropped: number;
    twilioSilentChunksDropped: number;
    ownerTranslatedAudioChunks: number;
    remoteTranslatedAudioChunks: number;
    ownerTranslatedAudioDroppedByGate: number;
    remoteTranslatedAudioDroppedByGate: number;
    transcriptDeltas: number;
    transcriptDeltasDroppedByGate: number;
  };
  lastAppAudioAt?: string;
  lastTwilioMediaAt?: string;
  lastAppSpeechAt?: string;
  lastTwilioSpeechAt?: string;
  endedAt?: string;
}

export class CallRegistry {
  private readonly calls = new Map<string, CallSession>();
  private readonly recentDiagnostics: Array<Record<string, unknown>> = [];

  constructor(private readonly config: AppConfig) {}

  create(request: CreateCallRequest): CallSession {
    const callId = request.clientCallId ?? makeId('call');
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }

    const record: CallRecord = {
      callId,
      callSid: null,
      to: request.to,
      userLanguage: request.userLanguage,
      remoteLanguage: request.remoteLanguage,
      announceTranslationAtStart: request.announceTranslationAtStart ?? true,
      introMessageText: normalizeIntroText(request.introMessageText),
      introDisclaimerText: normalizeIntroText(request.introDisclaimerText),
      predictiveMode: request.predictiveMode ?? 'off',
      createdAt: new Date().toISOString(),
      state: 'created',
      appToken: makeAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, callId),
      transcripts: [],
      counters: {
        appAudioChunks: 0,
        twilioMediaChunks: 0,
        twilioOutboundEchoChunksDropped: 0,
        appSilentChunksDropped: 0,
        twilioSilentChunksDropped: 0,
        ownerTranslatedAudioChunks: 0,
        remoteTranslatedAudioChunks: 0,
        ownerTranslatedAudioDroppedByGate: 0,
        remoteTranslatedAudioDroppedByGate: 0,
        transcriptDeltas: 0,
        transcriptDeltasDroppedByGate: 0
      }
    };
    const session = new CallSession(this.config, record, (diagnostics) => this.delete(callId, diagnostics));
    this.calls.set(callId, session);
    return session;
  }

  get(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  delete(callId: string, diagnostics?: Record<string, unknown>): void {
    if (diagnostics) {
      this.recentDiagnostics.unshift(diagnostics);
      this.recentDiagnostics.splice(8);
    }
    this.calls.delete(callId);
  }

  listDiagnostics(): Array<Record<string, unknown>> {
    return Array.from(this.calls.values()).map((session) => session.diagnostics());
  }

  listRecentDiagnostics(): Array<Record<string, unknown>> {
    return this.recentDiagnostics;
  }
}

export class CallSession {
  private appWs?: WebSocket;
  private twilioWs?: WebSocket;
  private ownerToRemote?: OpenAiTranslationSession;
  private remoteToOwner?: OpenAiTranslationSession;
  private predictive?: PredictiveReservationController;

  constructor(
    private readonly config: AppConfig,
    private readonly record: CallRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {
    if (record.predictiveMode === 'restaurant_reservation_v1') {
      this.predictive = new PredictiveReservationController({
        userLanguage: record.userLanguage,
        remoteLanguage: record.remoteLanguage,
        speakToRemote: (text, phase) => this.speakPredictiveTextToRemote(text, phase),
        emitEvent: (event) => this.sendApp({ type: 'predictive_event', ...event })
      });
    }
  }

  get callId(): string {
    return this.record.callId;
  }

  get appToken(): string {
    return this.record.appToken;
  }

  get data(): CallRecord {
    return this.record;
  }

  setCallSid(callSid: string | null): void {
    this.record.callSid = callSid;
  }

  verifyAppToken(token: string): boolean {
    return Boolean(this.config.BRIDGE_MEDIA_SHARED_SECRET && verifyAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.callId, token));
  }

  verifyStreamToken(token: string): boolean {
    return Boolean(
      this.config.BRIDGE_MEDIA_SHARED_SECRET && verifyStreamToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.callId, token)
    );
  }

  appStreamUrl(): string {
    const base = this.config.APP_STREAM_PUBLIC_WSS_URL ?? `ws://localhost:${this.config.PORT}/app/stream`;
    return `${base}/${encodeURIComponent(this.callId)}?token=${encodeURIComponent(this.appToken)}`;
  }

  bindApp(ws: WebSocket): void {
    this.appWs?.close();
    this.appWs = ws;
    console.log(`[call:${this.callId}] app websocket connected`);
    this.touch();
    this.ensureTranslationSessions();
    this.sendStatus();

    ws.on('message', (raw) => this.handleAppMessage(raw.toString()));
    ws.on('close', () => {
      if (this.appWs === ws) {
        this.appWs = undefined;
        console.log(`[call:${this.callId}] app websocket closed`);
        this.sendStatus();
      }
    });
  }

  bindTwilio(ws: WebSocket, startMessage: Extract<TwilioMediaMessage, { event: 'start' }>): void {
    this.twilioWs?.close();
    this.twilioWs = ws;
    this.record.twilioStreamSid = startMessage.start.streamSid;
    this.record.callSid = startMessage.start.callSid;
    this.record.state = this.appWs ? 'live' : 'twilio-connected';
    console.log(`[call:${this.callId}] twilio media stream started ${this.record.twilioStreamSid}`);
    this.touch();
    this.ensureTranslationSessions();
    this.sendStatus();

    ws.on('message', (raw) => this.handleTwilioMessage(raw.toString()));
    ws.on('close', () => {
      if (this.twilioWs === ws) {
        this.twilioWs = undefined;
        this.record.state = this.appWs ? 'created' : 'ended';
        console.log(`[call:${this.callId}] twilio media stream closed`);
        this.sendStatus();
      }
    });
  }

  handleTwilioPreStart(ws: WebSocket, raw: string): boolean {
    let message: TwilioMediaMessage;
    try {
      message = JSON.parse(raw) as TwilioMediaMessage;
    } catch {
      ws.close();
      return false;
    }

    if (message.event === 'connected') {
      return false;
    }

    if (message.event !== 'start') {
      return false;
    }

    const params = message.start.customParameters ?? {};
    const callId = params.callId;
    const streamToken = params.streamToken;
    if (callId !== this.callId || !streamToken || !this.verifyStreamToken(streamToken)) {
      ws.close();
      return false;
    }

    this.bindTwilio(ws, message);
    return true;
  }

  sendDtmf(digit: string): void {
    if (!this.twilioWs || !this.record.twilioStreamSid) {
      this.sendApp({ type: 'error', message: 'Cannot send DTMF before Twilio media stream is live.' });
      return;
    }
    const payload = makeDtmfMuLaw8kBase64(digit);
    this.sendTwilioMedia(payload, `dtmf-${digit}-${Date.now()}`);
  }

  async hangup(): Promise<void> {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    this.ownerToRemote?.close();
    this.remoteToOwner?.close();
    this.appWs?.close();
    this.twilioWs?.close();
    try {
      await completeTwilioCall(this.config, this.record.callSid);
    } catch (error) {
      this.record.error = error instanceof Error ? error.message : 'Failed to complete Twilio call';
    }
    this.onDispose(this.diagnostics());
  }

  diagnostics(): Record<string, unknown> {
    return {
      callId: this.record.callId,
      callSid: this.record.callSid,
      state: this.record.state,
      to: redactPhone(this.record.to),
      userLanguage: this.record.userLanguage,
      remoteLanguage: this.record.remoteLanguage,
      introMessageText: redactIntroText(this.record.introMessageText),
      introDisclaimerText: redactIntroText(this.record.introDisclaimerText),
      ...(this.predictive?.diagnostics() ?? defaultPredictiveDiagnostics(this.record.predictiveMode)),
      appConnected: Boolean(this.appWs),
      twilioConnected: Boolean(this.twilioWs),
      twilioStreamSid: this.record.twilioStreamSid ?? null,
      sessionA: this.ownerToRemote?.status ?? 'idle',
      sessionB: this.remoteToOwner?.status ?? 'idle',
      error: this.record.error ?? null,
      counters: { ...this.record.counters },
      translationSessionConfig: {
        inputTranscriptionModel: 'gpt-realtime-whisper',
        inputNoiseReduction: 'near_field'
      },
      transcriptDiagnosticNote:
        'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptDeltaCount: this.record.counters.transcriptDeltas,
      transcriptDeltaRetainedCount: this.record.transcripts.length,
      transcriptTail: this.record.transcripts.slice(-MAX_TRANSCRIPT_DIAGNOSTIC_TAIL),
      lastActivityAt: this.record.lastActivityAt ?? null,
      lastAppAudioAt: this.record.lastAppAudioAt ?? null,
      lastTwilioMediaAt: this.record.lastTwilioMediaAt ?? null,
      lastAppSpeechAt: this.record.lastAppSpeechAt ?? null,
      lastTwilioSpeechAt: this.record.lastTwilioSpeechAt ?? null,
      endedAt: this.record.endedAt ?? null
    };
  }

  private handleAppMessage(raw: string): void {
    let message: AppClientMessage;
    try {
      message = JSON.parse(raw) as AppClientMessage;
    } catch {
      this.sendApp({ type: 'error', message: 'Invalid app websocket JSON.' });
      return;
    }

    this.touch();
    if (message.type === 'audio') {
      this.record.counters.appAudioChunks += 1;
      this.record.lastAppAudioAt = new Date().toISOString();
      this.trackAppAudioActivity(message.audio);
      this.ensureTranslationSessions();
      this.ownerToRemote?.appendPcm16Base64(message.audio);
      return;
    }
    if (message.type === 'dtmf') {
      this.sendDtmf(message.digit);
      return;
    }
    if (message.type === 'hangup') {
      void this.hangup();
      return;
    }
    if (message.type === 'start') {
      this.ensureTranslationSessions();
      this.sendStatus();
    }
  }

  private handleTwilioMessage(raw: string): void {
    let message: TwilioMediaMessage;
    try {
      message = JSON.parse(raw) as TwilioMediaMessage;
    } catch {
      return;
    }

    this.touch();
    if (message.event === 'media') {
      this.record.counters.twilioMediaChunks += 1;
      this.record.lastTwilioMediaAt = new Date().toISOString();
      if (message.media.track === 'outbound') {
        this.record.counters.twilioOutboundEchoChunksDropped += 1;
        return;
      }
      const pcm24k = twilioMuLaw8kBase64ToOpenAiPcm24kBase64(message.media.payload);
      const remoteSpeechDetected = this.trackTwilioAudioActivity(pcm24k);
      this.predictive?.handleRemoteAudioActivity(remoteSpeechDetected);
      this.ensureTranslationSessions();
      this.remoteToOwner?.appendPcm16Base64(pcm24k);
      return;
    }
    if (message.event === 'dtmf') {
      this.emitTranscript('remote', 'source', `[DTMF ${message.dtmf.digit}]`);
      return;
    }
    if (message.event === 'stop') {
      this.record.state = 'ended';
      this.record.endedAt = new Date().toISOString();
      this.ownerToRemote?.close();
      this.remoteToOwner?.close();
      this.sendStatus();
      this.onDispose(this.diagnostics());
    }
  }

  private ensureTranslationSessions(): void {
    if (!this.ownerToRemote) {
      this.ownerToRemote = new OpenAiTranslationSession({
        config: this.config,
        direction: 'owner-to-remote',
        targetLanguage: this.record.remoteLanguage,
        onAudioDelta: (pcm24k) => {
          if (this.predictive?.shouldSuppressOwnerTranslation()) {
            this.predictive.recordSuppressedOwnerAudioChunk();
            return;
          }
          if (!this.isRecentSpeech('owner')) {
            this.record.counters.ownerTranslatedAudioDroppedByGate += 1;
            return;
          }
          this.record.counters.ownerTranslatedAudioChunks += 1;
          const muLaw8k = openAiPcm24kBase64ToTwilioMuLaw8kBase64(pcm24k);
          this.sendTwilioMedia(muLaw8k, `owner-to-remote-${Date.now()}`);
        },
        onInputTranscriptDelta: (delta) => {
          this.predictive?.handleOwnerSourceDelta(delta);
          this.emitTranscript('owner', 'source', delta);
        },
        onOutputTranscriptDelta: (delta) => this.emitTranscript('owner', 'translation', delta),
        onStatus: () => this.sendStatus(),
        onError: (error) => this.fail(error)
      });
      this.ownerToRemote.connect();
    }

    if (!this.remoteToOwner) {
      this.remoteToOwner = new OpenAiTranslationSession({
        config: this.config,
        direction: 'remote-to-owner',
        targetLanguage: this.record.userLanguage,
        onAudioDelta: (pcm24k) => {
          if (!this.isRecentRemoteMedia()) {
            this.record.counters.remoteTranslatedAudioDroppedByGate += 1;
            return;
          }
          this.record.counters.remoteTranslatedAudioChunks += 1;
          this.sendApp({ type: 'translated_audio', speaker: 'remote', audio: pcm24k, sampleRate: 24000, encoding: 'pcm16' });
        },
        onInputTranscriptDelta: (delta) => this.emitTranscript('remote', 'source', delta),
        onOutputTranscriptDelta: (delta) => {
          if (this.isRecentRemoteMedia()) {
            this.predictive?.handleRemoteTranslationDelta(delta);
          }
          this.emitTranscript('remote', 'translation', delta);
        },
        onStatus: () => this.sendStatus(),
        onError: (error) => this.fail(error)
      });
      this.remoteToOwner.connect();
    }
  }

  private emitTranscript(speaker: 'owner' | 'remote', kind: 'source' | 'translation', delta: string): void {
    if (!this.isTranscriptAllowed(speaker)) {
      this.record.counters.transcriptDeltasDroppedByGate += 1;
      return;
    }
    this.record.counters.transcriptDeltas += 1;
    this.record.transcripts.push({ at: new Date().toISOString(), speaker, kind, delta });
    if (this.record.transcripts.length > MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS) {
      this.record.transcripts.splice(0, this.record.transcripts.length - MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS);
    }
    this.sendApp({ type: 'transcript_delta', speaker, transcriptKind: kind, delta });
  }

  private sendTwilioMedia(payload: string, markName: string): void {
    if (!this.twilioWs || !this.record.twilioStreamSid) {
      return;
    }
    this.twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.record.twilioStreamSid,
        media: { payload }
      })
    );
    this.twilioWs.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.record.twilioStreamSid,
        mark: { name: markName }
      })
    );
  }

  private async speakPredictiveTextToRemote(text: string, phase: 'prefix' | 'completion'): Promise<number> {
    const pcm24k = await createSpeechPcm24kBase64(this.config, {
      text,
      language: this.record.remoteLanguage
    });
    return this.sendPcm24kToTwilioInChunks(pcm24k, `predictive-${phase}-${Date.now()}`);
  }

  private sendPcm24kToTwilioInChunks(pcm24k: string, markPrefix: string): number {
    const muLaw8k = openAiPcm24kBase64ToTwilioMuLaw8kBase64(pcm24k);
    const bytes = base64ToBytes(muLaw8k);
    const chunkSize = 160;
    let chunks = 0;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      this.sendTwilioMedia(bytesToBase64(chunk), `${markPrefix}-${chunks}`);
      chunks += 1;
    }
    return chunks;
  }

  private sendApp(message: AppServerMessage): void {
    if (!this.appWs || this.appWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.appWs.send(JSON.stringify(message));
  }

  private sendStatus(): void {
    this.sendApp({
      type: 'status',
      callId: this.callId,
      state: this.record.state,
      twilioConnected: Boolean(this.twilioWs),
      appConnected: Boolean(this.appWs),
      sessionA: this.ownerToRemote?.status ?? 'idle',
      sessionB: this.remoteToOwner?.status ?? 'idle'
    });
  }

  private fail(error: Error): void {
    this.record.state = 'error';
    this.record.error = error.message;
    console.error(`[call:${this.callId}] ${error.message}`);
    this.sendApp({ type: 'error', message: error.message });
    this.sendStatus();
  }

  private touch(): void {
    this.record.lastActivityAt = new Date().toISOString();
  }

  private trackAppAudioActivity(base64Pcm16: string): boolean {
    return this.trackInputAudioActivity(base64Pcm16, 'owner');
  }

  private trackTwilioAudioActivity(base64Pcm16: string): boolean {
    return this.trackInputAudioActivity(base64Pcm16, 'remote');
  }

  private trackInputAudioActivity(base64Pcm16: string, speaker: 'owner' | 'remote'): boolean {
    const rms = pcm16Rms(base64ToPcm16(base64Pcm16));
    if (rms < SPEECH_RMS_THRESHOLD) {
      return false;
    }
    const now = new Date().toISOString();
    if (speaker === 'owner') {
      this.record.lastAppSpeechAt = now;
    } else {
      this.record.lastTwilioSpeechAt = now;
    }
    return true;
  }

  private isRecentSpeech(speaker: 'owner' | 'remote', windowMs = OUTPUT_SPEECH_HANGOVER_MS): boolean {
    const timestamp = speaker === 'owner' ? this.record.lastAppSpeechAt : this.record.lastTwilioSpeechAt;
    if (!timestamp) {
      return false;
    }
    return Date.now() - Date.parse(timestamp) <= windowMs;
  }

  private isRecentRemoteMedia(windowMs = REMOTE_MEDIA_OUTPUT_HANGOVER_MS): boolean {
    const timestamp = this.record.lastTwilioMediaAt ?? this.record.lastTwilioSpeechAt;
    if (!timestamp) {
      return false;
    }
    return Date.now() - Date.parse(timestamp) <= windowMs;
  }

  private isTranscriptAllowed(speaker: 'owner' | 'remote'): boolean {
    if (speaker === 'remote') {
      return this.isRecentRemoteMedia();
    }
    return this.isRecentSpeech('owner');
  }
}

function redactPhone(phone: string): string {
  if (phone.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

function normalizeIntroText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 800) : undefined;
}

function redactIntroText(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function defaultPredictiveDiagnostics(mode: PredictiveMode): Record<string, unknown> {
  return {
    predictiveMode: mode,
    predictiveActiveTurn: false,
    predictiveRecognizedIntent: null,
    predictivePendingSlot: null,
    predictiveResolvedSlots: {},
    predictiveSuppressedOwnerAudioChunks: 0,
    predictivePrefixAudioChunks: 0,
    predictiveCompletionAudioChunks: 0,
    remoteQuestionUnderstoodAt: null,
    safePrefixFirstAudioAt: null,
    userSlotDetectedAt: null,
    completionFirstAudioAt: null
  };
}

function pcm16Rms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}
