import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeId, signValue } from './auth.js';
import { base64ToBytes, base64ToPcm16, bytesToBase64 } from './audio/codec.js';
import { createSpeechPcm24kBase64 } from './openai/speech.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import { fillerTextForLanguage } from './predictive/reservationController.js';
import type { FillerVoiceGender, PredictiveMode, TranscriptKind } from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;
const SPEECH_RMS_THRESHOLD = 0.003;
const FILLER_AFTER_SILENCE_MS = 1_000;
const FILLER_REPEAT_MS = 4_800;
const FILLER_CHUNK_INTERVAL_MS = 100;
const FILLER_TRANSLATION_RECENT_MS = 350;
const APP_TO_APP_INVITE_TTL_MS = 30 * 60 * 1000;
const APP_TO_APP_INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type AppToAppParticipant = 'initiator' | 'receiver';

type TranscriptSpeaker = 'owner' | 'remote';

type TranscriptEntry = {
  at: string;
  from: AppToAppParticipant;
  to: AppToAppParticipant;
  participantView: AppToAppParticipant;
  speaker: TranscriptSpeaker;
  kind: TranscriptKind;
  delta: string;
};

type FillerOverlayState = {
  id: number;
  source: AppToAppParticipant;
  target: AppToAppParticipant;
  cancelled: boolean;
  chunkTimer?: ReturnType<typeof setTimeout>;
  repeatTimer?: ReturnType<typeof setTimeout>;
};

export interface CreateAppToAppSessionRequest {
  initiatorLanguage: string;
  receiverLanguage: string;
  clientSessionId?: string;
  fillerBridgeEnabled?: boolean;
  fillerVoiceGender?: FillerVoiceGender;
  predictiveMode?: PredictiveMode;
}

type AppToAppClientMessage =
  | { type: 'start' }
  | {
      type: 'audio';
      audio: string;
      sampleRate?: 24000;
      encoding?: 'pcm16';
    }
  | { type: 'hangup' };

type AppToAppServerMessage =
  | {
      type: 'status';
      sessionId: string;
      participant: AppToAppParticipant;
      state: string;
      initiatorConnected: boolean;
      receiverConnected: boolean;
      sessionA: string;
      sessionB: string;
    }
  | {
      type: 'translated_audio';
      speaker: TranscriptSpeaker;
      from: AppToAppParticipant;
      to: AppToAppParticipant;
      audio: string;
      sampleRate: 24000;
      encoding: 'pcm16';
    }
  | {
      type: 'transcript_delta';
      speaker: TranscriptSpeaker;
      from: AppToAppParticipant;
      to: AppToAppParticipant;
      transcriptKind: TranscriptKind;
      delta: string;
    }
  | {
      type: 'participant_activity';
      participant: AppToAppParticipant;
      speaking: boolean;
      audioRmsPercent: number;
      at: string;
    }
  | { type: 'error'; message: string };

interface AppToAppRecord {
  sessionId: string;
  inviteCode: string;
  inviteExpiresAt: string;
  initiatorLanguage: string;
  receiverLanguage: string;
  createdAt: string;
  state: 'created' | 'live' | 'ended' | 'error';
  error?: string;
  initiatorToken: string;
  receiverToken: string;
  lastActivityAt?: string;
  endedAt?: string;
  fillerBridgeEnabled: boolean;
  fillerVoiceGender: FillerVoiceGender;
  predictiveMode: PredictiveMode;
  lastSpeechAt: Partial<Record<AppToAppParticipant, string>>;
  lastFillerAt: Partial<Record<AppToAppParticipant, string>>;
  lastFillerText: Partial<Record<AppToAppParticipant, string>>;
  speaking: Record<AppToAppParticipant, boolean>;
  lastAudioRms: Record<AppToAppParticipant, number>;
  timing: Record<AppToAppParticipant, ParticipantTiming>;
  transcripts: TranscriptEntry[];
  counters: {
    initiatorAudioChunks: number;
    receiverAudioChunks: number;
    translatedAudioChunksToInitiator: number;
    translatedAudioChunksToReceiver: number;
    fillerAudioChunksToInitiator: number;
    fillerAudioChunksToReceiver: number;
    fillerAttempts: number;
    fillerAudioClipsStarted: number;
    fillerSkippedTranslatedRecently: number;
    fillerSkippedTargetSpeaking: number;
    fillerSpeechErrors: number;
    transcriptDeltas: number;
  };
}

interface ParticipantTiming {
  firstAudioAt?: string;
  lastAudioAt?: string;
  firstInputTranscriptAt?: string;
  firstOutputTranscriptAt?: string;
  firstTranslatedAudioAt?: string;
  lastTranslatedAudioAt?: string;
  audioRmsAvg: number;
  audioRmsPeak: number;
  audioRmsSamples: number;
}

export class AppToAppRegistry {
  private readonly sessions = new Map<string, AppToAppSession>();
  private readonly inviteCodes = new Map<string, string>();
  private readonly recentDiagnostics: Array<Record<string, unknown>> = [];

  constructor(private readonly config: AppConfig) {}

  create(request: CreateAppToAppSessionRequest): AppToAppSession {
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }
    const sessionId = request.clientSessionId ?? makeId('app2app');
    const inviteCode = this.createUniqueInviteCode();
    const fillerBridgeEnabled = Boolean(
      request.fillerBridgeEnabled || request.predictiveMode === 'restaurant_reservation_v1'
    );
    const record: AppToAppRecord = {
      sessionId,
      inviteCode,
      inviteExpiresAt: new Date(Date.now() + APP_TO_APP_INVITE_TTL_MS).toISOString(),
      initiatorLanguage: request.initiatorLanguage,
      receiverLanguage: request.receiverLanguage,
      createdAt: new Date().toISOString(),
      state: 'created',
      initiatorToken: makeParticipantToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId, 'initiator'),
      receiverToken: makeParticipantToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId, 'receiver'),
      fillerBridgeEnabled,
      fillerVoiceGender: request.fillerVoiceGender ?? 'auto',
      predictiveMode: request.predictiveMode ?? 'off',
      lastSpeechAt: {},
      lastFillerAt: {},
      lastFillerText: {},
      speaking: {
        initiator: false,
        receiver: false
      },
      lastAudioRms: {
        initiator: 0,
        receiver: 0
      },
      timing: {
        initiator: createParticipantTiming(),
        receiver: createParticipantTiming()
      },
      transcripts: [],
      counters: {
        initiatorAudioChunks: 0,
        receiverAudioChunks: 0,
        translatedAudioChunksToInitiator: 0,
        translatedAudioChunksToReceiver: 0,
        fillerAudioChunksToInitiator: 0,
        fillerAudioChunksToReceiver: 0,
        fillerAttempts: 0,
        fillerAudioClipsStarted: 0,
        fillerSkippedTranslatedRecently: 0,
        fillerSkippedTargetSpeaking: 0,
        fillerSpeechErrors: 0,
        transcriptDeltas: 0
      }
    };
    const session = new AppToAppSession(this.config, record, (diagnostics) => this.delete(sessionId, diagnostics));
    this.sessions.set(sessionId, session);
    this.inviteCodes.set(inviteCode, sessionId);
    return session;
  }

  get(sessionId: string): AppToAppSession | undefined {
    return this.sessions.get(sessionId);
  }

  getByInviteCode(inviteCode: string): AppToAppSession | undefined {
    const normalized = normalizeInviteCode(inviteCode);
    const sessionId = this.inviteCodes.get(normalized);
    if (!sessionId) {
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.inviteExpired()) {
      this.inviteCodes.delete(normalized);
      return undefined;
    }
    return session;
  }

  delete(sessionId: string, diagnostics?: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.inviteCodes.delete(session.inviteCode);
    }
    if (diagnostics) {
      this.recentDiagnostics.unshift(diagnostics);
      this.recentDiagnostics.splice(8);
    }
    this.sessions.delete(sessionId);
  }

  listDiagnostics(): Array<Record<string, unknown>> {
    return Array.from(this.sessions.values()).map((session) => session.diagnostics());
  }

  listRecentDiagnostics(): Array<Record<string, unknown>> {
    return this.recentDiagnostics;
  }

  private createUniqueInviteCode(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = makeInviteCode();
      if (!this.inviteCodes.has(code)) {
        return code;
      }
    }
    throw new Error('Unable to allocate app-to-app invite code');
  }
}

export class AppToAppSession {
  private initiatorWs?: WebSocket;
  private receiverWs?: WebSocket;
  private initiatorToReceiver?: OpenAiTranslationSession;
  private receiverToInitiator?: OpenAiTranslationSession;
  private readonly fillerTimers: Partial<Record<AppToAppParticipant, ReturnType<typeof setTimeout>>> = {};
  private readonly fillerOverlays: Partial<Record<AppToAppParticipant, FillerOverlayState>> = {};
  private readonly fillerAudioCache = new Map<string, Promise<string>>();
  private readonly preparedFillerText: Partial<Record<AppToAppParticipant, string>> = {};
  private readonly speakingTimers: Partial<Record<AppToAppParticipant, ReturnType<typeof setTimeout>>> = {};
  private fillerOverlaySequence = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly record: AppToAppRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {}

  get sessionId(): string {
    return this.record.sessionId;
  }

  get inviteCode(): string {
    return this.record.inviteCode;
  }

  inviteExpired(): boolean {
    return Date.now() > Date.parse(this.record.inviteExpiresAt);
  }

  receiverInvite(): Record<string, unknown> {
    if (this.inviteExpired()) {
      throw new Error('invite expired');
    }
    return {
      sessionId: this.sessionId,
      role: 'receiver',
      initiatorLanguage: this.record.initiatorLanguage,
      receiverLanguage: this.record.receiverLanguage,
      receiverStreamUrl: this.participantStreamUrl('receiver'),
      inviteCode: this.record.inviteCode,
      inviteExpiresAt: this.record.inviteExpiresAt
    };
  }

  verifyParticipantToken(participant: AppToAppParticipant, token: string): boolean {
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      return false;
    }
    const expected = participant === 'initiator' ? this.record.initiatorToken : this.record.receiverToken;
    return token === expected;
  }

  participantStreamUrl(participant: AppToAppParticipant): string {
    const base = this.appToAppStreamBaseUrl();
    const token = participant === 'initiator' ? this.record.initiatorToken : this.record.receiverToken;
    return `${base}/${encodeURIComponent(this.sessionId)}/${participant}?token=${encodeURIComponent(token)}`;
  }

  diagnostics(): Record<string, unknown> {
    return {
      sessionId: this.record.sessionId,
      inviteCode: this.record.inviteCode,
      inviteExpiresAt: this.record.inviteExpiresAt,
      state: this.record.state,
      mode: 'app-to-app',
      initiatorLanguage: this.record.initiatorLanguage,
      receiverLanguage: this.record.receiverLanguage,
      initiatorConnected: Boolean(this.initiatorWs),
      receiverConnected: Boolean(this.receiverWs),
      sessionA: this.initiatorToReceiver?.status ?? 'idle',
      sessionB: this.receiverToInitiator?.status ?? 'idle',
      fillerBridgeEnabled: this.record.fillerBridgeEnabled,
      fillerVoiceGender: this.record.fillerVoiceGender,
      predictiveMode: this.record.predictiveMode,
      fillerModeNote: this.record.fillerBridgeEnabled
        ? 'App-to-app filler overlay is enabled. It sends slow, non-substantive filler to the listener after source-speaker silence, then cancels as soon as real translated audio starts.'
        : 'App-to-app filler is off.',
      lastSpeechAt: { ...this.record.lastSpeechAt },
      lastFillerAt: { ...this.record.lastFillerAt },
      lastFillerText: { ...this.record.lastFillerText },
      fillerOverlayActive: {
        initiator: Boolean(this.fillerOverlays.initiator && !this.fillerOverlays.initiator.cancelled),
        receiver: Boolean(this.fillerOverlays.receiver && !this.fillerOverlays.receiver.cancelled)
      },
      speaking: { ...this.record.speaking },
      lastAudioRmsPercent: {
        initiator: Number((this.record.lastAudioRms.initiator * 100).toFixed(2)),
        receiver: Number((this.record.lastAudioRms.receiver * 100).toFixed(2))
      },
      timing: {
        initiator: summarizeParticipantTiming(this.record.timing.initiator),
        receiver: summarizeParticipantTiming(this.record.timing.receiver)
      },
      error: this.record.error ?? null,
      counters: { ...this.record.counters },
      transcriptDiagnosticNote: 'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptTail: this.record.transcripts.slice(-120),
      lastActivityAt: this.record.lastActivityAt ?? null,
      endedAt: this.record.endedAt ?? null
    };
  }

  bindParticipant(participant: AppToAppParticipant, ws: WebSocket): void {
    const previous = this.wsFor(participant);
    previous?.close();
    this.setWsFor(participant, ws);
    this.record.state = 'live';
    this.touch();
    this.ensureTranslationSessions();
    this.prewarmFillerForTarget(participant);
    this.sendStatusToBoth();

    ws.on('message', (raw) => this.handleParticipantMessage(participant, raw.toString()));
    ws.on('close', () => {
      if (this.wsFor(participant) === ws) {
        this.setWsFor(participant, undefined);
        this.touch();
        this.sendStatusToBoth();
        if (!this.initiatorWs && !this.receiverWs) {
          this.record.state = 'ended';
          this.record.endedAt = new Date().toISOString();
          this.initiatorToReceiver?.close();
          this.receiverToInitiator?.close();
          this.onDispose(this.diagnostics());
        }
      }
    });
  }

  private handleParticipantMessage(participant: AppToAppParticipant, raw: string): void {
    let message: AppToAppClientMessage;
    try {
      message = JSON.parse(raw) as AppToAppClientMessage;
    } catch {
      this.sendTo(participant, { type: 'error', message: 'Invalid app-to-app websocket JSON.' });
      return;
    }

    this.touch();
    if (message.type === 'start') {
      this.ensureTranslationSessions();
      this.sendStatusToBoth();
      return;
    }
    if (message.type === 'audio') {
      this.routeAudio(participant, message.audio);
      return;
    }
    if (message.type === 'hangup') {
      this.close();
    }
  }

  private routeAudio(from: AppToAppParticipant, audio: string): void {
    this.ensureTranslationSessions();
    const rms = this.trackAudioTiming(from, audio);
    this.updateParticipantActivity(from, rms);
    this.trackParticipantAudioActivity(from, rms);
    if (from === 'initiator') {
      this.record.counters.initiatorAudioChunks += 1;
      this.initiatorToReceiver?.appendPcm16Base64(audio);
      return;
    }
    this.record.counters.receiverAudioChunks += 1;
    this.receiverToInitiator?.appendPcm16Base64(audio);
  }

  private updateParticipantActivity(participant: AppToAppParticipant, rms: number): void {
    this.record.lastAudioRms[participant] = rms;
    if (rms < SPEECH_RMS_THRESHOLD) {
      return;
    }

    if (!this.record.speaking[participant]) {
      this.record.speaking[participant] = true;
      this.sendActivityToBoth(participant, true, rms);
    }

    const existing = this.speakingTimers[participant];
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.record.speaking[participant] = false;
      this.sendActivityToBoth(participant, false, this.record.lastAudioRms[participant]);
    }, 900);
    timer.unref?.();
    this.speakingTimers[participant] = timer;
  }

  private sendActivityToBoth(participant: AppToAppParticipant, speaking: boolean, rms: number): void {
    const message: AppToAppServerMessage = {
      type: 'participant_activity',
      participant,
      speaking,
      audioRmsPercent: Number((rms * 100).toFixed(2)),
      at: new Date().toISOString()
    };
    this.sendTo('initiator', message);
    this.sendTo('receiver', message);
  }

  private trackParticipantAudioActivity(participant: AppToAppParticipant, rms: number): void {
    if (!this.record.fillerBridgeEnabled) {
      return;
    }
    if (rms < SPEECH_RMS_THRESHOLD) {
      return;
    }
    this.cancelFillerForTarget(participant);
    this.record.lastSpeechAt[participant] = new Date().toISOString();
    this.scheduleFillerAfterSilence(participant);
  }

  private scheduleFillerAfterSilence(participant: AppToAppParticipant): void {
    const existing = this.fillerTimers[participant];
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => void this.maybeStartFillerOverlay(participant), FILLER_AFTER_SILENCE_MS);
    timer.unref?.();
    this.fillerTimers[participant] = timer;
  }

  private async maybeStartFillerOverlay(source: AppToAppParticipant): Promise<void> {
    if (!this.record.fillerBridgeEnabled || this.record.state === 'ended') {
      return;
    }
    this.record.counters.fillerAttempts += 1;
    const lastSpeechAt = this.record.lastSpeechAt[source];
    if (!lastSpeechAt || Date.now() - Date.parse(lastSpeechAt) < FILLER_AFTER_SILENCE_MS) {
      return;
    }
    if (this.translatedAudioRecentlyFlowing(source)) {
      this.record.counters.fillerSkippedTranslatedRecently += 1;
      return;
    }
    const target = otherParticipant(source);
    this.cancelFillerForTarget(target);
    await this.speakFillerOverlayPhrase(source, target);
  }

  private async speakFillerOverlayPhrase(source: AppToAppParticipant, target: AppToAppParticipant): Promise<void> {
    if (!this.record.fillerBridgeEnabled || this.record.state === 'ended') {
      return;
    }
    const lastSpeechAt = this.record.lastSpeechAt[source];
    if (!lastSpeechAt || this.translatedAudioRecentlyFlowing(source)) {
      if (lastSpeechAt) {
        this.record.counters.fillerSkippedTranslatedRecently += 1;
      }
      return;
    }
    if (this.record.speaking[target]) {
      this.record.counters.fillerSkippedTargetSpeaking += 1;
      return;
    }

    const ws = this.wsFor(target);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const overlay: FillerOverlayState = {
      id: ++this.fillerOverlaySequence,
      source,
      target,
      cancelled: false
    };
    this.fillerOverlays[target] = overlay;

    const language = this.languageForParticipant(target);
    const text = this.preparedFillerText[target] ?? this.nextFillerText(target);
    delete this.preparedFillerText[target];
    this.record.lastFillerText[target] = text;
    this.record.lastFillerAt[target] = new Date().toISOString();

    try {
      const pcm24k = await this.getFillerPcm24k(text, language);
      if (overlay.cancelled || this.fillerOverlays[target] !== overlay || this.translatedAudioRecentlyFlowing(source)) {
        this.cancelFillerForTarget(target);
        return;
      }
      this.record.counters.fillerAudioClipsStarted += 1;
      const chunks = this.sendFillerPcm24kToParticipantPaced(overlay, pcm24k);
      if (target === 'initiator') {
        this.record.counters.fillerAudioChunksToInitiator += chunks;
      } else {
        this.record.counters.fillerAudioChunksToReceiver += chunks;
      }
      if (!overlay.cancelled && this.fillerOverlays[target] === overlay) {
        this.prewarmFillerForTarget(target);
        overlay.repeatTimer = setTimeout(() => void this.speakFillerOverlayPhrase(source, target), FILLER_REPEAT_MS);
        overlay.repeatTimer.unref?.();
      }
    } catch (error) {
      this.cancelFillerForTarget(target);
      this.record.counters.fillerSpeechErrors += 1;
      this.record.error = error instanceof Error ? error.message : 'App-to-app filler speech failed';
      this.sendTo(target, {
        type: 'error',
        message: this.record.error
      });
    }
  }

  private sendFillerPcm24kToParticipantPaced(overlay: FillerOverlayState, pcm24k: string): number {
    const bytes = fadePcm16Base64(pcm24k);
    const chunkSize = 4800;
    const chunks = Math.ceil(bytes.length / chunkSize);
    const sendChunk = (index: number): void => {
      if (overlay.cancelled || this.fillerOverlays[overlay.target] !== overlay || this.record.state === 'ended') {
        return;
      }
      const offset = index * chunkSize;
      if (offset >= bytes.length) {
        return;
      }
      const chunk = bytes.slice(offset, offset + chunkSize);
      this.sendTo(overlay.target, {
        type: 'translated_audio',
        speaker: 'remote',
        from: overlay.source,
        to: overlay.target,
        audio: bytesToBase64(chunk),
        sampleRate: 24000,
        encoding: 'pcm16'
      });
      overlay.chunkTimer = setTimeout(() => sendChunk(index + 1), FILLER_CHUNK_INTERVAL_MS);
      overlay.chunkTimer.unref?.();
    };
    sendChunk(0);
    return chunks;
  }

  private cancelFillerForTarget(target: AppToAppParticipant): void {
    const overlay = this.fillerOverlays[target];
    if (!overlay) {
      return;
    }
    overlay.cancelled = true;
    if (overlay.chunkTimer) {
      clearTimeout(overlay.chunkTimer);
    }
    if (overlay.repeatTimer) {
      clearTimeout(overlay.repeatTimer);
    }
    delete this.fillerOverlays[target];
  }

  private translatedAudioRecentlyFlowing(source: AppToAppParticipant): boolean {
    const lastTranslatedAudioAt = this.record.timing[source].lastTranslatedAudioAt;
    if (!lastTranslatedAudioAt) {
      return false;
    }
    return Date.now() - Date.parse(lastTranslatedAudioAt) < FILLER_TRANSLATION_RECENT_MS;
  }

  private languageForParticipant(participant: AppToAppParticipant): string {
    return participant === 'initiator' ? this.record.initiatorLanguage : this.record.receiverLanguage;
  }

  private nextFillerText(target: AppToAppParticipant): string {
    return fillerTextForLanguage(this.languageForParticipant(target), '', this.record.lastFillerText[target] ?? '');
  }

  private prewarmFillerForTarget(target: AppToAppParticipant): void {
    if (!this.record.fillerBridgeEnabled || this.record.state === 'ended' || this.preparedFillerText[target]) {
      return;
    }
    const text = this.nextFillerText(target);
    this.preparedFillerText[target] = text;
    void this.getFillerPcm24k(text, this.languageForParticipant(target)).catch((error) => {
      this.record.counters.fillerSpeechErrors += 1;
      this.record.error = error instanceof Error ? error.message : 'App-to-app filler prewarm failed';
      if (this.preparedFillerText[target] === text) {
        delete this.preparedFillerText[target];
      }
    });
  }

  private getFillerPcm24k(text: string, language: string): Promise<string> {
    const fillerVoice = this.fillerVoiceSettings();
    const key = [language, fillerVoice.voice, text].join('\u0000');
    const cached = this.fillerAudioCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = createSpeechPcm24kBase64(this.config, {
      text,
      language,
      voice: fillerVoice.voice,
      instructions: `Speak naturally in ${language}. This is a very short thinking filler in a two-person translated web session. ${fillerVoice.instructions} Do not add any words beyond the input text.`,
      speed: 0.98
    });
    this.fillerAudioCache.set(key, promise);
    return promise;
  }

  private fillerVoiceSettings(): { voice: string; instructions: string } {
    switch (this.record.fillerVoiceGender) {
      case 'male':
        return {
          voice: this.config.OPENAI_FILLER_TTS_VOICE_MALE,
          instructions: 'Use a clearly masculine adult voice with a calm conversational delivery.'
        };
      case 'female':
        return {
          voice: this.config.OPENAI_FILLER_TTS_VOICE_FEMALE,
          instructions: 'Use a clearly feminine adult voice with a warm conversational delivery.'
        };
      case 'auto':
      default:
        return {
          voice: this.config.OPENAI_FILLER_TTS_VOICE,
          instructions: 'Use the configured default filler voice with a natural, calm delivery.'
        };
    }
  }

  private ensureTranslationSessions(): void {
    if (!this.initiatorToReceiver) {
      this.initiatorToReceiver = new OpenAiTranslationSession({
        config: this.config,
        direction: 'owner-to-remote',
        targetLanguage: this.record.receiverLanguage,
        onAudioDelta: (pcm24k) => {
          this.trackTranslatedAudioTiming('initiator');
          this.record.counters.translatedAudioChunksToReceiver += 1;
          this.cancelFillerForTarget('receiver');
          this.sendTo('receiver', {
            type: 'translated_audio',
            speaker: 'remote',
            from: 'initiator',
            to: 'receiver',
            audio: pcm24k,
            sampleRate: 24000,
            encoding: 'pcm16'
          });
        },
        onInputTranscriptDelta: (delta) => {
          this.trackTranscriptTiming('initiator', 'source');
          this.emitTranscript('initiator', 'source', delta);
        },
        onOutputTranscriptDelta: (delta) => {
          this.trackTranscriptTiming('initiator', 'translation');
          this.emitTranscript('initiator', 'translation', delta);
        },
        onStatus: () => this.sendStatusToBoth(),
        onError: (error) => this.fail(error)
      });
      this.initiatorToReceiver.connect();
    }

    if (!this.receiverToInitiator) {
      this.receiverToInitiator = new OpenAiTranslationSession({
        config: this.config,
        direction: 'remote-to-owner',
        targetLanguage: this.record.initiatorLanguage,
        onAudioDelta: (pcm24k) => {
          this.trackTranslatedAudioTiming('receiver');
          this.record.counters.translatedAudioChunksToInitiator += 1;
          this.cancelFillerForTarget('initiator');
          this.sendTo('initiator', {
            type: 'translated_audio',
            speaker: 'remote',
            from: 'receiver',
            to: 'initiator',
            audio: pcm24k,
            sampleRate: 24000,
            encoding: 'pcm16'
          });
        },
        onInputTranscriptDelta: (delta) => {
          this.trackTranscriptTiming('receiver', 'source');
          this.emitTranscript('receiver', 'source', delta);
        },
        onOutputTranscriptDelta: (delta) => {
          this.trackTranscriptTiming('receiver', 'translation');
          this.emitTranscript('receiver', 'translation', delta);
        },
        onStatus: () => this.sendStatusToBoth(),
        onError: (error) => this.fail(error)
      });
      this.receiverToInitiator.connect();
    }
  }

  private emitTranscript(from: AppToAppParticipant, kind: TranscriptKind, delta: string): void {
    const to = otherParticipant(from);
    this.record.counters.transcriptDeltas += 1;
    this.record.transcripts.push({
      at: new Date().toISOString(),
      from,
      to,
      participantView: from,
      speaker: 'owner',
      kind,
      delta
    });
    this.record.transcripts.push({
      at: new Date().toISOString(),
      from,
      to,
      participantView: to,
      speaker: 'remote',
      kind,
      delta
    });
    if (this.record.transcripts.length > MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS) {
      this.record.transcripts.splice(0, this.record.transcripts.length - MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS);
    }
    this.sendTo(from, {
      type: 'transcript_delta',
      speaker: 'owner',
      from,
      to,
      transcriptKind: kind,
      delta
    });
    this.sendTo(to, {
      type: 'transcript_delta',
      speaker: 'remote',
      from,
      to,
      transcriptKind: kind,
      delta
    });
  }

  private trackAudioTiming(participant: AppToAppParticipant, audio: string): number {
    const timing = this.record.timing[participant];
    const now = new Date().toISOString();
    timing.firstAudioAt ??= now;
    timing.lastAudioAt = now;

    const rms = pcm16RmsForAppToAppDiagnostics(audio);
    timing.audioRmsSamples += 1;
    timing.audioRmsAvg += (rms - timing.audioRmsAvg) / timing.audioRmsSamples;
    timing.audioRmsPeak = Math.max(timing.audioRmsPeak, rms);
    return rms;
  }

  private trackTranscriptTiming(participant: AppToAppParticipant, kind: TranscriptKind): void {
    const timing = this.record.timing[participant];
    const now = new Date().toISOString();
    if (kind === 'source') {
      timing.firstInputTranscriptAt ??= now;
      return;
    }
    timing.firstOutputTranscriptAt ??= now;
  }

  private trackTranslatedAudioTiming(sourceParticipant: AppToAppParticipant): void {
    const timing = this.record.timing[sourceParticipant];
    const now = new Date().toISOString();
    timing.firstTranslatedAudioAt ??= now;
    timing.lastTranslatedAudioAt = now;
  }

  private close(): void {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    for (const timer of Object.values(this.fillerTimers)) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.cancelFillerForTarget('initiator');
    this.cancelFillerForTarget('receiver');
    for (const timer of Object.values(this.speakingTimers)) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.initiatorToReceiver?.close();
    this.receiverToInitiator?.close();
    this.initiatorWs?.close();
    this.receiverWs?.close();
    this.onDispose(this.diagnostics());
  }

  private sendStatusToBoth(): void {
    this.sendStatus('initiator');
    this.sendStatus('receiver');
  }

  private sendStatus(participant: AppToAppParticipant): void {
    this.sendTo(participant, {
      type: 'status',
      sessionId: this.sessionId,
      participant,
      state: this.record.state,
      initiatorConnected: Boolean(this.initiatorWs),
      receiverConnected: Boolean(this.receiverWs),
      sessionA: this.initiatorToReceiver?.status ?? 'idle',
      sessionB: this.receiverToInitiator?.status ?? 'idle'
    });
  }

  private sendTo(participant: AppToAppParticipant, message: AppToAppServerMessage): void {
    const ws = this.wsFor(participant);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private fail(error: Error): void {
    this.record.state = 'error';
    this.record.error = error.message;
    this.sendTo('initiator', { type: 'error', message: error.message });
    this.sendTo('receiver', { type: 'error', message: error.message });
    this.sendStatusToBoth();
  }

  private touch(): void {
    this.record.lastActivityAt = new Date().toISOString();
  }

  private wsFor(participant: AppToAppParticipant): WebSocket | undefined {
    return participant === 'initiator' ? this.initiatorWs : this.receiverWs;
  }

  private setWsFor(participant: AppToAppParticipant, ws: WebSocket | undefined): void {
    if (participant === 'initiator') {
      this.initiatorWs = ws;
      return;
    }
    this.receiverWs = ws;
  }

  private appToAppStreamBaseUrl(): string {
    if (this.config.APP_STREAM_PUBLIC_WSS_URL) {
      return this.config.APP_STREAM_PUBLIC_WSS_URL.replace(/\/app\/stream\/?$/, '/app-to-app/stream');
    }
    return `ws://localhost:${this.config.PORT}/app-to-app/stream`;
  }
}

function makeParticipantToken(secret: string, sessionId: string, participant: AppToAppParticipant): string {
  return signValue(secret, `app-to-app:${sessionId}:${participant}`);
}

function makeInviteCode(): string {
  let code = '';
  const bytes = crypto.randomBytes(9);
  for (const byte of bytes) {
    code += APP_TO_APP_INVITE_ALPHABET[byte % APP_TO_APP_INVITE_ALPHABET.length];
  }
  return code;
}

function normalizeInviteCode(inviteCode: string): string {
  return inviteCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function otherParticipant(participant: AppToAppParticipant): AppToAppParticipant {
  return participant === 'initiator' ? 'receiver' : 'initiator';
}

function fadePcm16Base64(base64: string, sampleRate = 24000, fadeMs = 35): Uint8Array {
  const pcm = base64ToPcm16(base64);
  const fadeSamples = Math.min(Math.floor((sampleRate * fadeMs) / 1000), Math.floor(pcm.length / 2));
  for (let index = 0; index < fadeSamples; index += 1) {
    const scale = index / fadeSamples;
    pcm[index] = Math.round(pcm[index] * scale);
    const tailIndex = pcm.length - 1 - index;
    pcm[tailIndex] = Math.round(pcm[tailIndex] * scale);
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function createParticipantTiming(): ParticipantTiming {
  return {
    audioRmsAvg: 0,
    audioRmsPeak: 0,
    audioRmsSamples: 0
  };
}

function summarizeParticipantTiming(timing: ParticipantTiming): Record<string, unknown> {
  return {
    ...timing,
    audioRmsAvgPercent: Number((timing.audioRmsAvg * 100).toFixed(2)),
    audioRmsPeakPercent: Number((timing.audioRmsPeak * 100).toFixed(2)),
    firstInputTranscriptLatencyMs: latencyMs(timing.firstAudioAt, timing.firstInputTranscriptAt),
    firstOutputTranscriptLatencyMs: latencyMs(timing.firstAudioAt, timing.firstOutputTranscriptAt),
    firstTranslatedAudioLatencyMs: latencyMs(timing.firstAudioAt, timing.firstTranslatedAudioAt)
  };
}

function latencyMs(start?: string, end?: string): number | null {
  if (!start || !end) {
    return null;
  }
  return Date.parse(end) - Date.parse(start);
}

export function pcm16RmsForAppToAppDiagnostics(base64Pcm16: string): number {
  const samples = base64ToPcm16(base64Pcm16);
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
