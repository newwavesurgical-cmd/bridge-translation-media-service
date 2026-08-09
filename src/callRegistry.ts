import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, verifyAppToken, verifyStreamToken } from './auth.js';
import {
  makeDtmfMuLaw8kBase64,
  openAiPcm24kBase64ToTwilioMuLaw8kBase64,
  twilioMuLaw8kBase64ToOpenAiPcm24kBase64
} from './audio/codec.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import { completeTwilioCall } from './twilio/client.js';
import type { AppClientMessage, AppServerMessage, CreateCallRequest, TwilioMediaMessage } from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;
const MAX_TRANSCRIPT_DIAGNOSTIC_TAIL = 200;

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
    ownerTranslatedAudioChunks: number;
    remoteTranslatedAudioChunks: number;
    transcriptDeltas: number;
  };
  lastAppAudioAt?: string;
  lastTwilioMediaAt?: string;
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
      createdAt: new Date().toISOString(),
      state: 'created',
      appToken: makeAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, callId),
      transcripts: [],
      counters: {
        appAudioChunks: 0,
        twilioMediaChunks: 0,
        ownerTranslatedAudioChunks: 0,
        remoteTranslatedAudioChunks: 0,
        transcriptDeltas: 0
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

  constructor(
    private readonly config: AppConfig,
    private readonly record: CallRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {}

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
      appConnected: Boolean(this.appWs),
      twilioConnected: Boolean(this.twilioWs),
      twilioStreamSid: this.record.twilioStreamSid ?? null,
      sessionA: this.ownerToRemote?.status ?? 'idle',
      sessionB: this.remoteToOwner?.status ?? 'idle',
      error: this.record.error ?? null,
      counters: this.record.counters,
      transcriptDiagnosticNote:
        'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptDeltaCount: this.record.counters.transcriptDeltas,
      transcriptDeltaRetainedCount: this.record.transcripts.length,
      transcriptTail: this.record.transcripts.slice(-MAX_TRANSCRIPT_DIAGNOSTIC_TAIL),
      lastActivityAt: this.record.lastActivityAt ?? null,
      lastAppAudioAt: this.record.lastAppAudioAt ?? null,
      lastTwilioMediaAt: this.record.lastTwilioMediaAt ?? null,
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
      this.ensureTranslationSessions();
      const pcm24k = twilioMuLaw8kBase64ToOpenAiPcm24kBase64(message.media.payload);
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
          this.record.counters.ownerTranslatedAudioChunks += 1;
          const muLaw8k = openAiPcm24kBase64ToTwilioMuLaw8kBase64(pcm24k);
          this.sendTwilioMedia(muLaw8k, `owner-to-remote-${Date.now()}`);
        },
        onInputTranscriptDelta: (delta) => this.emitTranscript('owner', 'source', delta),
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
          this.record.counters.remoteTranslatedAudioChunks += 1;
          this.sendApp({ type: 'translated_audio', speaker: 'remote', audio: pcm24k, sampleRate: 24000, encoding: 'pcm16' });
        },
        onInputTranscriptDelta: (delta) => this.emitTranscript('remote', 'source', delta),
        onOutputTranscriptDelta: (delta) => this.emitTranscript('remote', 'translation', delta),
        onStatus: () => this.sendStatus(),
        onError: (error) => this.fail(error)
      });
      this.remoteToOwner.connect();
    }
  }

  private emitTranscript(speaker: 'owner' | 'remote', kind: 'source' | 'translation', delta: string): void {
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
}

function redactPhone(phone: string): string {
  if (phone.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}
