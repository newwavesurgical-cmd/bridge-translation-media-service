import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, verifyAppToken } from './auth.js';
import { base64ToPcm16 } from './audio/codec.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import type { CreateInPersonSessionRequest, TranscriptKind } from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;

type InPersonSpeaker = 'owner' | 'partner';
type InPersonTarget = 'user' | 'partner';

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
  lastActivityAt?: string;
  endedAt?: string;
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
    const record: InPersonRecord = {
      sessionId,
      userLanguage: request.userLanguage,
      partnerLanguage: request.partnerLanguage,
      createdAt: new Date().toISOString(),
      state: 'created',
      appToken: makeAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId),
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

  constructor(
    private readonly config: AppConfig,
    private readonly record: InPersonRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {}

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
      mode: 'in-person-native-dual-channel',
      userLanguage: this.record.userLanguage,
      partnerLanguage: this.record.partnerLanguage,
      appConnected: Boolean(this.appWs),
      sessionA: this.ownerToPartner?.status ?? 'idle',
      sessionB: this.partnerToOwner?.status ?? 'idle',
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
        onInputTranscriptDelta: (delta) => this.emitTranscript('owner', 'source', 'partner', delta),
        onOutputTranscriptDelta: (delta) => this.emitTranscript('owner', 'translation', 'partner', delta),
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
        onInputTranscriptDelta: (delta) => this.emitTranscript('partner', 'source', 'user', delta),
        onOutputTranscriptDelta: (delta) => this.emitTranscript('partner', 'translation', 'user', delta),
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

  private close(): void {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    this.ownerToPartner?.close();
    this.partnerToOwner?.close();
    this.appWs?.close();
    this.onDispose(this.diagnostics());
  }

  private sendStatus(): void {
    this.sendApp({
      type: 'status',
      sessionId: this.sessionId,
      state: this.record.state,
      appConnected: Boolean(this.appWs),
      sessionA: this.ownerToPartner?.status ?? 'idle',
      sessionB: this.partnerToOwner?.status ?? 'idle'
    });
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
