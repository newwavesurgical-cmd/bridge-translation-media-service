import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, makeInPersonDisplayToken, verifyAppToken, verifyInPersonDisplayToken } from './auth.js';
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
const MAX_AUDIO_TIMING_EVENTS = 80;
const SINGLE_MIC_ROUTE_PRIME_SPEECH_RMS = 0.012;
const SINGLE_MIC_ROUTE_ARMED_TIMEOUT_MS = 5000;
const SINGLE_MIC_ROUTE_POST_SPEECH_SILENCE_MS = 1800;
const STRICT_PARTNER_SPEECH_RMS = 0.012;
const STRICT_PARTNER_TURN_SILENCE_MS = 550;
const STRICT_PENDING_AUDIO_CHUNKS_MAX = 240;
const STRICT_PENDING_TRANSCRIPT_DELTAS_MAX = 160;

type InPersonSpeaker = 'owner' | 'partner';
type InPersonTarget = 'user' | 'partner';
export type InPersonDisplayView = 'owner' | 'partner';
type SingleMicRoute = 'auto' | InPersonSpeaker;

type TranscriptEntry = {
  at: string;
  speaker: InPersonSpeaker;
  kind: TranscriptKind;
  delta: string;
};

type StrictPendingTranscript = {
  kind: TranscriptKind;
  delta: string;
};

type InPersonTranslationDirection = 'ownerToPartner' | 'partnerToOwner';

type AudioTimingEvent = {
  at: string;
  direction: InPersonTranslationDirection;
  event: 'input' | 'openai_audio' | 'emit' | 'suppress';
  gapMs?: number;
  reason?: string;
};

type AudioTimingStats = {
  inputChunks: number;
  openAiAudioChunks: number;
  emittedAudioChunks: number;
  suppressedAudioChunks: number;
  firstInputAt?: string;
  lastInputAt?: string;
  firstOpenAiAudioAt?: string;
  lastOpenAiAudioAt?: string;
  firstEmittedAt?: string;
  lastEmittedAt?: string;
  lastSuppressedAt?: string;
  lastInputToOpenAiAudioMs?: number;
  lastOpenAiToEmitMs?: number;
  lastOpenAiAudioGapMs?: number;
  maxOpenAiAudioGapMs: number;
  avgOpenAiAudioGapMs: number;
  openAiAudioGapSamples: number;
  lastEmitGapMs?: number;
  maxEmitGapMs: number;
  avgEmitGapMs: number;
  emitGapSamples: number;
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
      routeOverrideAgeMs?: number | null;
      routeOverrideSpeechAgeMs?: number | null;
      routeOverrideLastSpeechAgeMs?: number | null;
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

type InPersonDisplayServerMessage =
  | {
      type: 'display_status';
      sessionId: string;
      view: InPersonDisplayView;
      target: InPersonTarget;
      state: string;
      appConnected: boolean;
      userLanguage: string;
      partnerLanguage: string;
    }
  | {
      type: 'display_snapshot';
      sessionId: string;
      view: InPersonDisplayView;
      target: InPersonTarget;
      transcriptTail: TranscriptEntry[];
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
  audioTiming: Record<InPersonTranslationDirection, AudioTimingStats>;
  audioTimingEvents: AudioTimingEvent[];
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
    const languageGateMode =
      request.languageGateMode ??
      (inputMode === 'single_mic_auto'
        ? 'soft_suppress'
        : inputMode === 'single_mic_hold_to_speak'
          ? 'strict_suppress'
          : 'monitor');
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
      audioTiming: {
        ownerToPartner: createAudioTimingStats(),
        partnerToOwner: createAudioTimingStats()
      },
      audioTimingEvents: [],
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
  private readonly displaySockets: Record<InPersonDisplayView, Set<WebSocket>> = {
    owner: new Set(),
    partner: new Set()
  };
  private ownerToPartner?: OpenAiTranslationSession;
  private partnerToOwner?: OpenAiTranslationSession;
  private readonly languageGates: Record<InPersonSpeaker, TranscriptLanguageGate>;
  private singleMicRoute: SingleMicRoute = 'auto';
  private singleMicRouteSetAt = 0;
  private singleMicRouteSpeechStartedAt = 0;
  private singleMicRouteLastSpeechAt = 0;
  private lastSentActiveSingleMicRoute: SingleMicRoute | null = null;
  private strictPartnerSpeechActive = false;
  private strictPartnerLastSpeechAt = 0;
  private readonly strictPartnerPending: {
    audio: string[];
    transcripts: StrictPendingTranscript[];
  } = { audio: [], transcripts: [] };

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

  verifyDisplayToken(view: InPersonDisplayView, token: string): boolean {
    return Boolean(
      this.config.BRIDGE_MEDIA_SHARED_SECRET &&
        verifyInPersonDisplayToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.sessionId, view, token)
    );
  }

  streamUrl(): string {
    const base = this.inPersonStreamBaseUrl();
    return `${base}/${encodeURIComponent(this.sessionId)}?token=${encodeURIComponent(this.record.appToken)}`;
  }

  displayStreamUrl(view: InPersonDisplayView): string {
    const base = this.inPersonDisplayStreamBaseUrl();
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }
    const token = makeInPersonDisplayToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.sessionId, view);
    return `${base}/${encodeURIComponent(this.sessionId)}/${view}?token=${encodeURIComponent(token)}`;
  }

  displayStreams(): Record<InPersonDisplayView, { view: InPersonDisplayView; target: InPersonTarget; streamUrl: string }> {
    return {
      owner: {
        view: 'owner',
        target: 'user',
        streamUrl: this.displayStreamUrl('owner')
      },
      partner: {
        view: 'partner',
        target: 'partner',
        streamUrl: this.displayStreamUrl('partner')
      }
    };
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
        this.closeDisplaySockets();
        this.onDispose(this.diagnostics());
      }
    });
  }

  bindDisplay(view: InPersonDisplayView, ws: WebSocket): void {
    this.displaySockets[view].add(ws);
    this.sendDisplayStatus(view, ws);
    this.sendDisplaySnapshot(view, ws);

    ws.on('message', () => {
      this.sendDisplay(ws, { type: 'error', message: 'Display connections are read-only.' });
    });
    ws.on('close', () => {
      this.displaySockets[view].delete(ws);
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
      displaySubscribers: {
        owner: this.displaySockets.owner.size,
        partner: this.displaySockets.partner.size
      },
      sessionA: this.ownerToPartner?.status ?? 'idle',
      sessionB: this.partnerToOwner?.status ?? 'idle',
      singleMicRoute: this.singleMicRoute,
      activeSingleMicRoute: this.activeSingleMicRoute(),
      routeOverride: this.singleMicRoute !== 'auto',
      routeOverrideAgeMs: this.singleMicRouteSetAt ? Date.now() - this.singleMicRouteSetAt : null,
      routeOverrideSpeechAgeMs: this.singleMicRouteSpeechStartedAt ? Date.now() - this.singleMicRouteSpeechStartedAt : null,
      routeOverrideLastSpeechAgeMs: this.singleMicRouteLastSpeechAt ? Date.now() - this.singleMicRouteLastSpeechAt : null,
      languageGateMode: this.record.languageGateMode,
      languageGateNote:
        'Transcript-based language gate. strict_suppress is fail-closed for the released Hold-mode partner lane: transcript and translated audio are buffered until the configured partner language passes, and operator-language turns are discarded.',
      routingModeNote: this.routingModeNote(),
      languageGate: {
        owner: this.languageGates.owner.diagnostics(),
        partner: this.languageGates.partner.diagnostics()
      },
      strictPartnerIsolation: {
        enabled: this.strictPartnerIsolationEnabled(),
        speechActive: this.strictPartnerSpeechActive,
        pendingAudioChunks: this.strictPartnerPending.audio.length,
        pendingTranscriptDeltas: this.strictPartnerPending.transcripts.length
      },
      error: this.record.error ?? null,
      counters: { ...this.record.counters },
      audioTimingNote:
        'Server-side timing only. input = app audio received by media service; openai_audio = translated audio delta received from OpenAI; emit = media service sent translated audio to app; suppress = server intentionally dropped translated audio.',
      audioTiming: {
        ownerToPartner: { ...this.record.audioTiming.ownerToPartner },
        partnerToOwner: { ...this.record.audioTiming.partnerToOwner }
      },
      audioTimingTail: this.record.audioTimingEvents.slice(-60),
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
    const frameRoute = this.validateSingleMicRoute(route);
    if (route && !frameRoute) {
      return;
    }
    if (frameRoute && frameRoute !== 'auto') {
      this.routeAudio(frameRoute, audio);
      return;
    }
    this.updateTemporarySingleMicRoute(audio);
    if (this.singleMicRoute === 'owner' || this.singleMicRoute === 'partner') {
      this.routeAudio(this.singleMicRoute, audio);
      return;
    }
    this.routeAudio('owner', audio);
    this.routeAudio('partner', audio);
  }

  private setSingleMicRoute(route: SingleMicRoute, sendStatus = true): void {
    const validated = this.validateSingleMicRoute(route);
    if (!validated) {
      return;
    }
    this.singleMicRoute = validated;
    this.singleMicRouteSetAt = validated === 'auto' ? 0 : Date.now();
    this.singleMicRouteSpeechStartedAt = 0;
    this.singleMicRouteLastSpeechAt = 0;
    if (sendStatus) {
      this.sendStatus();
    }
  }

  private validateSingleMicRoute(route: SingleMicRoute | undefined): SingleMicRoute | null {
    if (!route) {
      return null;
    }
    if (route === 'auto' || route === 'owner' || route === 'partner') {
      return route;
    }
    this.sendApp({
      type: 'error',
      message: 'Invalid single mic route. Expected auto, owner, or partner.'
    });
    return null;
  }

  private updateTemporarySingleMicRoute(audio: string): void {
    if (this.singleMicRoute !== 'owner' && this.singleMicRoute !== 'partner') {
      return;
    }
    const now = Date.now();
    const rms = pcm16RmsForInPersonDiagnostics(audio);
    const speechLikely = rms >= SINGLE_MIC_ROUTE_PRIME_SPEECH_RMS;
    if (speechLikely) {
      if (!this.singleMicRouteSpeechStartedAt) {
        this.singleMicRouteSpeechStartedAt = now;
      }
      this.singleMicRouteLastSpeechAt = now;
      return;
    }

    if (!this.singleMicRouteSpeechStartedAt) {
      if (this.singleMicRouteSetAt && now - this.singleMicRouteSetAt >= SINGLE_MIC_ROUTE_ARMED_TIMEOUT_MS) {
        this.resetSingleMicRouteToAuto();
      }
      return;
    }

    if (this.singleMicRouteLastSpeechAt && now - this.singleMicRouteLastSpeechAt >= SINGLE_MIC_ROUTE_POST_SPEECH_SILENCE_MS) {
      this.resetSingleMicRouteToAuto();
    }
  }

  private resetSingleMicRouteToAuto(): void {
    if (this.singleMicRoute === 'auto') {
      return;
    }
    this.singleMicRoute = 'auto';
    this.singleMicRouteSetAt = 0;
    this.singleMicRouteSpeechStartedAt = 0;
    this.singleMicRouteLastSpeechAt = 0;
    this.sendStatus();
  }

  private routeAudio(speaker: InPersonSpeaker, audio: string): void {
    this.ensureTranslationSessions();
    if (speaker === 'owner') {
      this.record.counters.userAudioChunks += 1;
      this.trackAudioInput('ownerToPartner');
      this.ownerToPartner?.appendPcm16Base64(audio);
      return;
    }
    this.updateStrictPartnerTurn(audio);
    this.record.counters.partnerAudioChunks += 1;
    this.trackAudioInput('partnerToOwner');
    this.partnerToOwner?.appendPcm16Base64(audio);
  }

  private ensureTranslationSessions(): void {
    if (!this.ownerToPartner) {
      this.ownerToPartner = new OpenAiTranslationSession({
        config: this.config,
        direction: 'owner-to-remote',
        targetLanguage: this.record.partnerLanguage,
        onAudioDelta: (pcm24k) => {
          this.trackOpenAiAudio('ownerToPartner');
          if (!this.shouldEmitTranslatedOutput('owner')) {
            this.trackSuppressedAudio('ownerToPartner', this.suppressionReasonFor('owner'));
            return;
          }
          this.record.counters.partnerTranslatedAudioChunks += 1;
          this.trackEmittedAudio('ownerToPartner');
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
          this.trackOpenAiAudio('partnerToOwner');
          if (this.strictPartnerIsolationEnabled()) {
            this.handleStrictPartnerAudio(pcm24k);
            return;
          }
          if (!this.shouldEmitTranslatedOutput('partner')) {
            this.trackSuppressedAudio('partnerToOwner', this.suppressionReasonFor('partner'));
            return;
          }
          this.record.counters.userTranslatedAudioChunks += 1;
          this.trackEmittedAudio('partnerToOwner');
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
          if (this.strictPartnerIsolationEnabled()) {
            this.handleStrictPartnerSourceTranscript(delta, decision);
            this.sendRouteStatusIfChanged();
            return;
          }
          if (this.shouldEmitTranscriptForDecision('partner', decision)) {
            this.emitTranscript('partner', 'source', 'user', delta);
          }
          this.sendRouteStatusIfChanged();
        },
        onOutputTranscriptDelta: (delta) => {
          if (this.strictPartnerIsolationEnabled()) {
            this.handleStrictPartnerTranslationTranscript(delta);
            return;
          }
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
    const message = { type: 'transcript_delta' as const, speaker, target, transcriptKind: kind, delta };
    this.sendApp(message);
    this.sendDisplayTranscript(target, message);
  }

  private shouldEmitTranscriptForDecision(speaker: InPersonSpeaker, decision: LanguageGateDecision): boolean {
    if (this.strictPartnerIsolationEnabled() && speaker === 'partner') {
      return decision === 'pass';
    }
    if (this.record.inputMode !== 'single_mic_auto') {
      return true;
    }
    if (this.singleMicRoute !== 'auto') {
      return this.singleMicRoute === speaker;
    }
    return decision === 'pass';
  }

  private shouldEmitTranslatedOutput(speaker: InPersonSpeaker): boolean {
    if (this.strictPartnerIsolationEnabled()) {
      if (speaker === 'owner') return true;
      return this.languageGates.partner.shouldPassOutput();
    }
    const gate = this.languageGates[speaker];
    if (this.record.inputMode === 'single_mic_auto') {
      if (this.singleMicRoute !== 'auto') {
        return this.singleMicRoute === speaker;
      }
      return gate.shouldPassOutput();
    }
    return !gate.shouldSuppressOutput();
  }

  private suppressionReasonFor(speaker: InPersonSpeaker): string {
    if (this.record.inputMode === 'single_mic_auto' && this.singleMicRoute !== 'auto') {
      return this.singleMicRoute === speaker ? 'not_suppressed' : `manual_route_${this.singleMicRoute}`;
    }
    const gateDiagnostics = this.languageGates[speaker].diagnostics();
    if (gateDiagnostics.suppressed) {
      return `language_gate_${gateDiagnostics.detectedLanguage ?? 'unknown'}`;
    }
    if (this.record.inputMode === 'single_mic_auto' && !gateDiagnostics.passFresh) {
      return 'language_gate_waiting_for_fresh_pass';
    }
    return 'unknown';
  }

  private strictPartnerIsolationEnabled(): boolean {
    return (
      this.record.inputMode === 'single_mic_hold_to_speak' &&
      this.record.languageGateMode === 'strict_suppress'
    );
  }

  private updateStrictPartnerTurn(audio: string): void {
    if (!this.strictPartnerIsolationEnabled()) return;
    const now = Date.now();
    const speechLikely = pcm16RmsForInPersonDiagnostics(audio) >= STRICT_PARTNER_SPEECH_RMS;
    if (speechLikely) {
      if (!this.strictPartnerSpeechActive) {
        this.beginStrictPartnerTurn();
      }
      this.strictPartnerSpeechActive = true;
      this.strictPartnerLastSpeechAt = now;
      return;
    }
    if (
      this.strictPartnerSpeechActive &&
      this.strictPartnerLastSpeechAt &&
      now - this.strictPartnerLastSpeechAt >= STRICT_PARTNER_TURN_SILENCE_MS
    ) {
      this.strictPartnerSpeechActive = false;
    }
  }

  private beginStrictPartnerTurn(): void {
    this.discardStrictPartnerPending('strict_new_turn_unverified');
    this.languageGates.partner.resetTurn();
  }

  private handleStrictPartnerSourceTranscript(
    delta: string,
    decision: LanguageGateDecision
  ): void {
    this.queueStrictPartnerTranscript('source', delta);
    if (decision === 'pass') {
      this.flushStrictPartnerPending();
    } else if (decision === 'suppress') {
      this.discardStrictPartnerPending('strict_operator_language');
    }
  }

  private handleStrictPartnerTranslationTranscript(delta: string): void {
    const decision = this.languageGates.partner.diagnostics().decision;
    if (decision === 'pass') {
      this.emitTranscript('partner', 'translation', 'user', delta);
      return;
    }
    if (decision === 'suppress') return;
    this.queueStrictPartnerTranscript('translation', delta);
  }

  private handleStrictPartnerAudio(pcm24k: string): void {
    const decision = this.languageGates.partner.diagnostics().decision;
    if (decision === 'pass') {
      this.emitPartnerTranslatedAudio(pcm24k);
      return;
    }
    if (decision === 'suppress') {
      this.trackSuppressedAudio('partnerToOwner', 'strict_operator_language');
      return;
    }
    this.strictPartnerPending.audio.push(pcm24k);
    if (this.strictPartnerPending.audio.length > STRICT_PENDING_AUDIO_CHUNKS_MAX) {
      this.strictPartnerPending.audio.shift();
      this.trackSuppressedAudio('partnerToOwner', 'strict_pending_cap');
    }
  }

  private queueStrictPartnerTranscript(kind: TranscriptKind, delta: string): void {
    this.strictPartnerPending.transcripts.push({ kind, delta });
    if (this.strictPartnerPending.transcripts.length > STRICT_PENDING_TRANSCRIPT_DELTAS_MAX) {
      this.strictPartnerPending.transcripts.shift();
    }
  }

  private flushStrictPartnerPending(): void {
    const transcripts = this.strictPartnerPending.transcripts.splice(0);
    const audio = this.strictPartnerPending.audio.splice(0);
    for (const entry of transcripts) {
      this.emitTranscript('partner', entry.kind, 'user', entry.delta);
    }
    for (const chunk of audio) {
      this.emitPartnerTranslatedAudio(chunk);
    }
  }

  private discardStrictPartnerPending(reason: string): void {
    const droppedAudio = this.strictPartnerPending.audio.splice(0);
    this.strictPartnerPending.transcripts.splice(0);
    for (let i = 0; i < droppedAudio.length; i += 1) {
      this.trackSuppressedAudio('partnerToOwner', reason);
    }
  }

  private emitPartnerTranslatedAudio(pcm24k: string): void {
    this.record.counters.userTranslatedAudioChunks += 1;
    this.trackEmittedAudio('partnerToOwner');
    this.sendApp({
      type: 'translated_audio',
      speaker: 'partner',
      target: 'user',
      audio: pcm24k,
      sampleRate: 24000,
      encoding: 'pcm16'
    });
  }

  private trackAudioInput(direction: InPersonTranslationDirection): void {
    const now = Date.now();
    const stats = this.record.audioTiming[direction];
    stats.inputChunks += 1;
    if (!stats.firstInputAt) {
      stats.firstInputAt = new Date(now).toISOString();
    }
    stats.lastInputAt = new Date(now).toISOString();
    this.recordAudioTimingEvent(direction, 'input', now);
  }

  private trackOpenAiAudio(direction: InPersonTranslationDirection): void {
    const now = Date.now();
    const stats = this.record.audioTiming[direction];
    stats.openAiAudioChunks += 1;
    if (!stats.firstOpenAiAudioAt) {
      stats.firstOpenAiAudioAt = new Date(now).toISOString();
    }
    if (stats.lastOpenAiAudioAt) {
      const gapMs = now - Date.parse(stats.lastOpenAiAudioAt);
      stats.lastOpenAiAudioGapMs = gapMs;
      stats.maxOpenAiAudioGapMs = Math.max(stats.maxOpenAiAudioGapMs, gapMs);
      stats.avgOpenAiAudioGapMs = rollingAverage(stats.avgOpenAiAudioGapMs, stats.openAiAudioGapSamples, gapMs);
      stats.openAiAudioGapSamples += 1;
      this.recordAudioTimingEvent(direction, 'openai_audio', now, gapMs);
    } else {
      this.recordAudioTimingEvent(direction, 'openai_audio', now);
    }
    stats.lastOpenAiAudioAt = new Date(now).toISOString();
    if (stats.lastInputAt) {
      stats.lastInputToOpenAiAudioMs = now - Date.parse(stats.lastInputAt);
    }
  }

  private trackEmittedAudio(direction: InPersonTranslationDirection): void {
    const now = Date.now();
    const stats = this.record.audioTiming[direction];
    stats.emittedAudioChunks += 1;
    if (!stats.firstEmittedAt) {
      stats.firstEmittedAt = new Date(now).toISOString();
    }
    if (stats.lastEmittedAt) {
      const gapMs = now - Date.parse(stats.lastEmittedAt);
      stats.lastEmitGapMs = gapMs;
      stats.maxEmitGapMs = Math.max(stats.maxEmitGapMs, gapMs);
      stats.avgEmitGapMs = rollingAverage(stats.avgEmitGapMs, stats.emitGapSamples, gapMs);
      stats.emitGapSamples += 1;
      this.recordAudioTimingEvent(direction, 'emit', now, gapMs);
    } else {
      this.recordAudioTimingEvent(direction, 'emit', now);
    }
    stats.lastEmittedAt = new Date(now).toISOString();
    if (stats.lastOpenAiAudioAt) {
      stats.lastOpenAiToEmitMs = now - Date.parse(stats.lastOpenAiAudioAt);
    }
  }

  private trackSuppressedAudio(direction: InPersonTranslationDirection, reason: string): void {
    const now = Date.now();
    const stats = this.record.audioTiming[direction];
    stats.suppressedAudioChunks += 1;
    stats.lastSuppressedAt = new Date(now).toISOString();
    this.recordAudioTimingEvent(direction, 'suppress', now, undefined, reason);
  }

  private recordAudioTimingEvent(
    direction: InPersonTranslationDirection,
    event: AudioTimingEvent['event'],
    now: number,
    gapMs?: number,
    reason?: string
  ): void {
    this.record.audioTimingEvents.push({
      at: new Date(now).toISOString(),
      direction,
      event,
      ...(gapMs === undefined ? {} : { gapMs }),
      ...(reason ? { reason } : {})
    });
    if (this.record.audioTimingEvents.length > MAX_AUDIO_TIMING_EVENTS) {
      this.record.audioTimingEvents.splice(0, this.record.audioTimingEvents.length - MAX_AUDIO_TIMING_EVENTS);
    }
  }

  private close(): void {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    this.ownerToPartner?.close();
    this.partnerToOwner?.close();
    this.appWs?.close();
    this.closeDisplaySockets();
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
      routeOverride: this.singleMicRoute !== 'auto',
      routeOverrideAgeMs: this.singleMicRouteSetAt ? Date.now() - this.singleMicRouteSetAt : null,
      routeOverrideSpeechAgeMs: this.singleMicRouteSpeechStartedAt ? Date.now() - this.singleMicRouteSpeechStartedAt : null,
      routeOverrideLastSpeechAgeMs: this.singleMicRouteLastSpeechAt ? Date.now() - this.singleMicRouteLastSpeechAt : null
    });
    this.sendDisplayStatus('owner');
    this.sendDisplayStatus('partner');
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

  private sendDisplayTranscript(
    target: InPersonTarget,
    message: Extract<InPersonDisplayServerMessage, { type: 'transcript_delta' }>
  ): void {
    const view = target === 'partner' ? 'partner' : 'owner';
    for (const ws of this.displaySockets[view]) {
      this.sendDisplay(ws, message);
    }
  }

  private sendDisplayStatus(view: InPersonDisplayView, specificSocket?: WebSocket): void {
    const target = displayTargetForView(view);
    const message: InPersonDisplayServerMessage = {
      type: 'display_status',
      sessionId: this.sessionId,
      view,
      target,
      state: this.record.state,
      appConnected: Boolean(this.appWs),
      userLanguage: this.record.userLanguage,
      partnerLanguage: this.record.partnerLanguage
    };
    if (specificSocket) {
      this.sendDisplay(specificSocket, message);
      return;
    }
    for (const ws of this.displaySockets[view]) {
      this.sendDisplay(ws, message);
    }
  }

  private sendDisplaySnapshot(view: InPersonDisplayView, ws: WebSocket): void {
    const target = displayTargetForView(view);
    this.sendDisplay(ws, {
      type: 'display_snapshot',
      sessionId: this.sessionId,
      view,
      target,
      transcriptTail: this.record.transcripts.filter((entry) => transcriptTarget(entry.speaker) === target).slice(-120)
    });
  }

  private sendDisplay(ws: WebSocket, message: InPersonDisplayServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private closeDisplaySockets(): void {
    for (const view of ['owner', 'partner'] as const) {
      for (const ws of this.displaySockets[view]) {
        ws.close();
      }
      this.displaySockets[view].clear();
    }
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

  private inPersonDisplayStreamBaseUrl(): string {
    if (this.config.APP_STREAM_PUBLIC_WSS_URL) {
      return this.config.APP_STREAM_PUBLIC_WSS_URL.replace(/\/app\/stream\/?$/, '/in-person/display');
    }
    return `ws://localhost:${this.config.PORT}/in-person/display`;
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

function createAudioTimingStats(): AudioTimingStats {
  return {
    inputChunks: 0,
    openAiAudioChunks: 0,
    emittedAudioChunks: 0,
    suppressedAudioChunks: 0,
    maxOpenAiAudioGapMs: 0,
    avgOpenAiAudioGapMs: 0,
    openAiAudioGapSamples: 0,
    maxEmitGapMs: 0,
    avgEmitGapMs: 0,
    emitGapSamples: 0
  };
}

function rollingAverage(currentAverage: number, samples: number, nextValue: number): number {
  return Math.round(((currentAverage * samples + nextValue) / (samples + 1)) * 10) / 10;
}

function displayTargetForView(view: InPersonDisplayView): InPersonTarget {
  return view === 'partner' ? 'partner' : 'user';
}

function transcriptTarget(speaker: InPersonSpeaker): InPersonTarget {
  return speaker === 'owner' ? 'partner' : 'user';
}
