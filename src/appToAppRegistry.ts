import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeId, signValue } from './auth.js';
import { base64ToPcm16 } from './audio/codec.js';
import { OpenAiTranslationSession } from './openai/translationSession.js';
import type { TranscriptKind } from './types/messages.js';

const MAX_TRANSCRIPT_DIAGNOSTIC_DELTAS = 300;

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

export interface CreateAppToAppSessionRequest {
  initiatorLanguage: string;
  receiverLanguage: string;
  clientSessionId?: string;
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
  | { type: 'error'; message: string };

interface AppToAppRecord {
  sessionId: string;
  initiatorLanguage: string;
  receiverLanguage: string;
  createdAt: string;
  state: 'created' | 'live' | 'ended' | 'error';
  error?: string;
  initiatorToken: string;
  receiverToken: string;
  lastActivityAt?: string;
  endedAt?: string;
  transcripts: TranscriptEntry[];
  counters: {
    initiatorAudioChunks: number;
    receiverAudioChunks: number;
    translatedAudioChunksToInitiator: number;
    translatedAudioChunksToReceiver: number;
    transcriptDeltas: number;
  };
}

export class AppToAppRegistry {
  private readonly sessions = new Map<string, AppToAppSession>();
  private readonly recentDiagnostics: Array<Record<string, unknown>> = [];

  constructor(private readonly config: AppConfig) {}

  create(request: CreateAppToAppSessionRequest): AppToAppSession {
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }
    const sessionId = request.clientSessionId ?? makeId('app2app');
    const record: AppToAppRecord = {
      sessionId,
      initiatorLanguage: request.initiatorLanguage,
      receiverLanguage: request.receiverLanguage,
      createdAt: new Date().toISOString(),
      state: 'created',
      initiatorToken: makeParticipantToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId, 'initiator'),
      receiverToken: makeParticipantToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId, 'receiver'),
      transcripts: [],
      counters: {
        initiatorAudioChunks: 0,
        receiverAudioChunks: 0,
        translatedAudioChunksToInitiator: 0,
        translatedAudioChunksToReceiver: 0,
        transcriptDeltas: 0
      }
    };
    const session = new AppToAppSession(this.config, record, (diagnostics) => this.delete(sessionId, diagnostics));
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AppToAppSession | undefined {
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

export class AppToAppSession {
  private initiatorWs?: WebSocket;
  private receiverWs?: WebSocket;
  private initiatorToReceiver?: OpenAiTranslationSession;
  private receiverToInitiator?: OpenAiTranslationSession;

  constructor(
    private readonly config: AppConfig,
    private readonly record: AppToAppRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {}

  get sessionId(): string {
    return this.record.sessionId;
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
      state: this.record.state,
      mode: 'app-to-app',
      initiatorLanguage: this.record.initiatorLanguage,
      receiverLanguage: this.record.receiverLanguage,
      initiatorConnected: Boolean(this.initiatorWs),
      receiverConnected: Boolean(this.receiverWs),
      sessionA: this.initiatorToReceiver?.status ?? 'idle',
      sessionB: this.receiverToInitiator?.status ?? 'idle',
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
    if (from === 'initiator') {
      this.record.counters.initiatorAudioChunks += 1;
      this.initiatorToReceiver?.appendPcm16Base64(audio);
      return;
    }
    this.record.counters.receiverAudioChunks += 1;
    this.receiverToInitiator?.appendPcm16Base64(audio);
  }

  private ensureTranslationSessions(): void {
    if (!this.initiatorToReceiver) {
      this.initiatorToReceiver = new OpenAiTranslationSession({
        config: this.config,
        direction: 'owner-to-remote',
        targetLanguage: this.record.receiverLanguage,
        onAudioDelta: (pcm24k) => {
          this.record.counters.translatedAudioChunksToReceiver += 1;
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
        onInputTranscriptDelta: (delta) => this.emitTranscript('initiator', 'source', delta),
        onOutputTranscriptDelta: (delta) => this.emitTranscript('initiator', 'translation', delta),
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
          this.record.counters.translatedAudioChunksToInitiator += 1;
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
        onInputTranscriptDelta: (delta) => this.emitTranscript('receiver', 'source', delta),
        onOutputTranscriptDelta: (delta) => this.emitTranscript('receiver', 'translation', delta),
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

  private close(): void {
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
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

function otherParticipant(participant: AppToAppParticipant): AppToAppParticipant {
  return participant === 'initiator' ? 'receiver' : 'initiator';
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
