import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, verifyAppToken } from './auth.js';
import { base64ToPcm16 } from './audio/codec.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import { TranscriptLanguageGate, type LanguageGateDecision } from './languageGate.js';
import type {
  CreateInPersonSessionRequest,
  InPersonInputMode,
  LanguageGateMode,
  TranscriptKind
} from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;

type InPersonSpeaker = 'owner' | 'partner';
type InPersonTarget = 'user' | 'partner';
type SingleMicRoute = 'auto' | InPersonSpeaker;

type TranscriptEntry = {
  at: string;
  speaker: InPersonSpeaker;
  kind: TranscriptKind;
  delta: string;
};

type InPersonClientMessage =
  | { type: 'start' }
  | {
      type: 'audio';
      speaker?: InPersonSpeaker | 'user';
      audio: string;
      sampleRate?: 24000;
      encoding?: 'pcm16';
    }
  | {
      type: 'single_audio';
      audio: string;
      route?: SingleMicRoute;
      sampleRate?: 24000;
      encoding?: 'pcm16';
    }
  | {
      type: 'set_single_mic_route';
      route: SingleMicRoute;
    }
  | {
      type: 'dual_audio';
      userAudio?: string;
      ownerAudio?: string;
      partnerAudio?: string;
      sampleRate?: 24000;
      encoding?: 'pcm16';
    }
  | { type: 'hangup' };

type InPersonServerMessage =
  | {
      type: 'status';
      sessionId: string;
      state: string;
      appConnected: boolean;
      sessionA: string;
      sessionB: string;
      singleMicRoute?: SingleMicRoute;
      activeSingleMicRoute?: SingleMicRoute;
      routeOverride?: boolean;
    }
  | {
      type: 'translated_audio';
      speaker: InPersonSpeaker;
      target: InPersonTarget;
      audio: string;
      sampleRate: 24000;
      encoding: 'pcm16';
    }
  | {
      type: 'transcript_delta';
      speaker: InPersonSpeaker;
      target: InPersonTarget;
      transcriptKind: TranscriptKind;
      delta: string;
    }
  | { type: 'error'; message: string };

interface InPersonRecord {
  sessionId: string;
  userLanguage: string;
  partnerLanguage: string;
  createdAt: string;
  state: 'created' | 'live' | 'ended' | 'error';
  error?: string;
  appToken: string;
  inputMode: InPersonInputMode;
  lastActivityAt?: string;
  endedAt?: string;
  languageGateMode: LanguageGateMode;
  transcripts: TranscriptEntry[];
  counters: {
    userAudioChunks: number;
    partnerAudioChunks: number;
    userTranslatedAudioChunks: number;
    partnerTranslatedAudioChunks: number;
    transcriptDeltas: number;
  };
}

export class InPersonRegistry {
  private readonly sessions = new Map<string, InPersonSession>();
  private readonly recentDiagnostics: Array<Record<string, unknown>> = [];

  constructor(private readonly config: AppConfig) {}

  create(request: CreateInPersonSessionRequest): InPersonSession {
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }
    const sessionId = request.clientSessionId ?? makeId('inperson');
    const inputMode = request.inputMode ?? 'dual_channel';
    const languageGateMode = request.languageGateMode ?? (inputMode === 'single_mic_auto' ? 'soft_suppress' : 'monitor');
    const record: InPersonRecord = {
      sessionId,
      userLanguage: request.userLanguage,
      partnerLanguage: request.partnerLanguage,
      createdAt: new Date().toISOString(),
      state: 'created',
      appToken: makeAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId),
      inputMode,
      languageGateMode,
      transcripts: [],
      counters: {
        userAudioChunks: 0,
        partnerAudioChunks: 0,
        userTranslatedAudioChunks: 0,
        partnerTranslatedAudioChunks: 0,
        transcriptDeltas: 0
      }
    };
    const session = new InPersonSession(this.config, record, (diagnostics) => this.delete(sessionId, diagnostics));
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): InPersonSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string, diagnostics?: Record<string, unknown>): void {
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
}

export class InPersonSession {
  private appWs?: WebSocket;
  private ownerToPartner?: OpenAiTranslationSession;
  private partnerToOwner?: OpenAiTranslationSession;
  private readonly languageGates: Record<InPersonSpeaker, TranscriptLanguageGate>;
  private singleMicRoute: SingleMicRoute = 'auto';
  private lastSentActiveSingleMicRoute: SingleMicRoute | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly record: InPersonRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {
    this.languageGates = {
      owner: new TranscriptLanguageGate(record.userLanguage, record.languageGateMode),
      partner: new TranscriptLanguageGate(record.partnerLanguage, record.languageGateMode)
    };
  }

  get sessionId(): string {
    return this.record.sessionId;
  }

  verifyAppToken(token: string): boolean {
    return Boolean(
      this.config.BRIDGE_MEDIA_SHARED_SECRET && verifyAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.sessionId, token)
    );
  }

  streamUrl(): string {
    const base = this.inPersonStreamBaseUrl();
    return `${base}/${encodeURIComponent(this.sessionId)}?token=${encodeURIComponent(this.record.appToken)}`;
  }

  bindApp(ws: WebSocket): void {
    this.appWs?.close();
    this.appWs = ws;
    this.record.state = 'live';
    this.touch();
    this.ensureTranslationSessions();
    this.sendStatus();

    ws.on('message', (raw) => this.handleAppMessage(raw.toString()));
    ws.on('close', () => {
      if (this.appWs === ws) {
        this.appWs = undefined;
        this.record.state = 'ended';
        this.record.endedAt = new Date().toISOString();
        this.ownerToPartner?.close();
        this.partnerToOwner?.close();
        this.onDispose(this.diagnostics());
      }
    });
  }

  diagnostics(): Record<string, unknown> {
    return {
      sessionId: this.record.sessionId,
      state: this.record.state,
      mode: this.diagnosticModeName(),
      inputMode: this.record.inputMode,
      phoneOnlyMode: this.record.inputMode !== 'dual_channel',
      userLanguage: this.record.userLanguage,
      partnerLanguage: this.record.partnerLanguage,
      appConnected: Boolean(this.appWs),
      sessionA: this.ownerToPartner?.status ?? 'idle',
      sessionB: this.partnerToOwner?.status ?? 'idle',
      singleMicRoute: this.singleMicRoute,
      activeSingleMicRoute: this.activeSingleMicRoute(),
      routeOverride: this.singleMicRoute !== 'auto',
      languageGateMode: this.record.languageGateMode,
      languageGateNote:
        'Transcript-based soft language gate. Monitor mode reports likely wrong-language pickup without muting; soft_suppress drops output from a channel only after confident opposite-language transcript evidence.',
      routingModeNote: this.routingModeNote(),
      languageGate: {
        owner: this.languageGates.owner.diagnostics(),
        partner: this.languageGates.partner.diagnostics()
      },
      error: this.record.error ?? null,
      counters: { ...this.record.counters },
      transcriptDiagnosticNote: 'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptTail: this.record.transcripts.slice(-120),
      lastActivityAt: this.record.lastActivityAt ?? null,
      endedAt: this.record.endedAt ?? null
    };
  }

  private handleAppMessage(raw: string): void {
    let message: InPersonClientMessage;
    try {
      message = JSON.parse(raw) as InPersonClientMessage;
    } catch {
      this.sendApp({ type: 'error', message: 'Invalid in-person websocket JSON.' });
      return;
    }

    this.touch();
    if (message.type === 'start') {
      this.ensureTranslationSessions();
      this.sendStatus();
      return;
    }
    if (message.type === 'audio') {
      const speaker = message.speaker === 'partner' ? 'partner' : 'owner';
      this.routeAudio(speaker, message.audio);
      return;
    }
    if (message.type === 'single_audio') {
      this.routeSingleMicAudio(message.audio, message.route);
      return;
    }
    if (message.type === 'set_single_mic_route') {
      this.setSingleMicRoute(message.route);
      return;
    }
    if (message.type === 'dual_audio') {
      const ownerAudio = message.ownerAudio ?? message.userAudio;
      if (ownerAudio) {
        this.routeAudio('owner', ownerAudio);
      }
      if (message.partnerAudio) {
        this.routeAudio('partner', message.partnerAudio);
      }
      return;
    }
    if (message.type === 'hangup') {
      this.close();
    }
  }

  private routeSingleMicAudio(audio: string, route?: SingleMicRoute): void {
    if (this.record.inputMode !== 'single_mic_auto') {
      this.sendApp({
        type: 'error',
        message: 'single_audio is only valid when inputMode is single_mic_auto.'
      });
      return;
    }
    if (route) {
      this.setSingleMicRoute(route, false);
    }
    if (this.singleMicRoute === 'owner' || this.singleMicRoute === 'partner') {
      this.routeAudio(this.singleMicRoute, audio);
      return;
    }
    this.routeAudio('owner', audio);
    this.routeAudio('partner', audio);
  }

  private setSingleMicRoute(route: SingleMicRoute, sendStatus = true): void {
    if (route !== 'auto' && route !== 'owner' && route !== 'partner') {
      this.sendApp({
        type: 'error',
        message: 'Invalid single mic route. Expected auto, owner, or partner.'
      });
      return;
    }
    this.singleMicRoute = route;
    if (sendStatus) {
      this.sendStatus();
    }
  }

  private routeAudio(speaker: InPersonSpeaker, audio: string): void {
    this.ensureTranslationSessions();
    if (speaker === 'owner') {
      this.record.counters.userAudioChunks += 1;
      this.ownerToPartner?.appendPcm16Base64(audio);
      return;
    }
    this.record.counters.partnerAudioChunks += 1;
    this.partnerToOwner?.appendPcm16Base64(audio);
  }

  private ensureTranslationSessions(): void {
    if (!this.ownerToPartner) {
      this.ownerToPartner = new OpenAiTranslationSession({
        config: this.config,
        direction: 'owner-to-remote',
        targetLanguage: this.record.partnerLanguage,
        onAudioDelta: (pcm24k) => {
          if (!this.shouldEmitTranslatedOutput('owner')) {
            return;
          }
          this.record.counters.partnerTranslatedAudioChunks += 1;
          this.sendApp({
            type: 'translated_audio',
            speaker: 'owner',
            target: 'partner',
            audio: pcm24k,
            sampleRate: 24000,
            encoding: 'pcm16'
          });
        },
        onInputTranscriptDelta: (delta) => {
          const decision = this.languageGates.owner.observe(delta);
          if (this.shouldEmitTranscriptForDecision('owner', decision)) {
            this.emitTranscript('owner', 'source', 'partner', delta);
          }
          this.sendRouteStatusIfChanged();
        },
        onOutputTranscriptDelta: (delta) => {
          if (this.shouldEmitTranslatedOutput('owner')) {
            this.emitTranscript('owner', 'translation', 'partner', delta);
          }
        },
        onStatus: () => this.sendStatus(),
        onError: (error) => this.fail(error)
      });
      this.ownerToPartner.connect();
    }

    if (!this.partnerToOwner) {
      this.partnerToOwner = new OpenAiTranslationSession({
        config: this.config,
        direction: 'remote-to-owner',
        targetLanguage: this.record.userLanguage,
        onAudioDelta: (pcm24k) => {
          if (!this.shouldEmitTranslatedOutput('partner')) {
            return;
          }
          this.record.counters.userTranslatedAudioChunks += 1;
          this.sendApp({
            type: 'translated_audio',
            speaker: 'partner',
            target: 'user',
            audio: pcm24k,
            sampleRate: 24000,
            encoding: 'pcm16'
          });
        },
        onInputTranscriptDelta: (delta) => {
          const decision = this.languageGates.partner.observe(delta);
          if (this.shouldEmitTranscriptForDecision('partner', decision)) {
            this.emitTranscript('partner', 'source', 'user', delta);
          }
          this.sendRouteStatusIfChanged();
        },
        onOutputTranscriptDelta: (delta) => {
          if (this.shouldEmitTranslatedOutput('partner')) {
            this.emitTranscript('partner', 'translation', 'user', delta);
          }
        },
        onStatus: () => this.sendStatus(),
        onError: (error) => this.fail(error)
      });
      this.partnerToOwner.connect();
    }
  }

  private emitTranscript(speaker: InPersonSpeaker, kind: TranscriptKind, target: InPersonTarget, delta: string): void {
    this.record.counters.transcriptDeltas += 1;
    this.record.transcripts.push({ at: new Date().toISOString(), speaker, kind, delta });
    if (this.record.transcripts.length > MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS) {
      this.record.transcripts.splice(0, this.record.transcripts.length - MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS);
    }
    this.sendApp({ type: 'transcript_delta', speaker, target, transcriptKind: kind, delta });
  }

  private shouldEmitTranscriptForDecision(speaker: InPersonSpeaker, decision: LanguageGateDecision): boolean {
    if (this.record.inputMode !== 'single_mic_auto') {
      return true;
    }
    if (this.singleMicRoute !== 'auto') {
      return this.singleMicRoute === speaker;
    }
    return decision === 'pass';
  }

  private shouldEmitTranslatedOutput(speaker: InPersonSpeaker): boolean {
    const gate = this.languageGates[speaker];
    if (this.record.inputMode === 'single_mic_auto') {
      if (this.singleMicRoute !== 'auto') {
        return this.singleMicRoute === speaker;
      }
      return gate.shouldPassOutput();
    }
    return !gate.shouldSuppressOutput();
  }

  private close(): void {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    this.ownerToPartner?.close();
    this.partnerToOwner?.close();
    this.appWs?.close();
    this.onDispose(this.diagnostics());
  }

  private sendStatus(): void {
    this.lastSentActiveSingleMicRoute = this.activeSingleMicRoute();
    this.sendApp({
      type: 'status',
      sessionId: this.sessionId,
      state: this.record.state,
      appConnected: Boolean(this.appWs),
      sessionA: this.ownerToPartner?.status ?? 'idle',
      sessionB: this.partnerToOwner?.status ?? 'idle',
      singleMicRoute: this.singleMicRoute,
      activeSingleMicRoute: this.lastSentActiveSingleMicRoute,
      routeOverride: this.singleMicRoute !== 'auto'
    });
  }

  private sendRouteStatusIfChanged(): void {
    if (this.record.inputMode !== 'single_mic_auto') {
      return;
    }
    const activeRoute = this.activeSingleMicRoute();
    if (activeRoute === this.lastSentActiveSingleMicRoute) {
      return;
    }
    this.sendStatus();
  }

  private sendApp(message: InPersonServerMessage): void {
    if (!this.appWs || this.appWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.appWs.send(JSON.stringify(message));
  }

  private fail(error: Error): void {
    this.record.state = 'error';
    this.record.error = error.message;
    this.sendApp({ type: 'error', message: error.message });
    this.sendStatus();
  }

  private touch(): void {
    this.record.lastActivityAt = new Date().toISOString();
  }

  private diagnosticModeName(): string {
    if (this.record.inputMode === 'single_mic_hold_to_speak') {
      return 'in-person-phone-hold-to-speak';
    }
    if (this.record.inputMode === 'single_mic_auto') {
      return 'in-person-phone-auto-language-routing';
    }
    return 'in-person-native-dual-channel';
  }

  private routingModeNote(): string {
    if (this.record.inputMode === 'single_mic_hold_to_speak') {
      return 'Phone-only hold-to-speak mode: the client sends the same physical microphone as owner while held/locked and partner while released. This is not true dual-channel full duplex.';
    }
    if (this.record.inputMode === 'single_mic_auto') {
      return 'Experimental phone-only automatic mode: the client sends one microphone stream as single_audio and the server feeds both translation directions while transcript language gates suppress confident wrong-language output.';
    }
    return 'Dual-channel mode: physical channel identity determines routing. owner/user audio translates to partner output; partner audio translates to user/private output.';
  }

  private activeSingleMicRoute(): SingleMicRoute {
    if (this.record.inputMode !== 'single_mic_auto') {
      return 'auto';
    }
    if (this.singleMicRoute !== 'auto') {
      return this.singleMicRoute;
    }
    const ownerDiagnostics = this.languageGates.owner.diagnostics();
    const partnerDiagnostics = this.languageGates.partner.diagnostics();
    if (ownerDiagnostics.passFresh && !partnerDiagnostics.passFresh) {
      return 'owner';
    }
    if (partnerDiagnostics.passFresh && !ownerDiagnostics.passFresh) {
      return 'partner';
    }
    return 'auto';
  }

  private inPersonStreamBaseUrl(): string {
    if (this.config.APP_STREAM_PUBLIC_WSS_URL) {
      return this.config.APP_STREAM_PUBLIC_WSS_URL.replace(/\/app\/stream\/?$/, '/in-person/stream');
    }
    return `ws://localhost:${this.config.PORT}/in-person/stream`;
  }
}

export function pcm16RmsForInPersonDiagnostics(base64Pcm16: string): number {
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
