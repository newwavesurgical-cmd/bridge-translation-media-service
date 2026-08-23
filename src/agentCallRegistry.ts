import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { makeAppToken, makeId, verifyAppToken, verifyStreamToken } from './auth.js';
import { OpenAiAgentVoiceSession, type AgentStartupDiagnostics } from './openai/agentVoiceSession.js';
import { completeTwilioCall } from './twilio/client.js';
import type { TwilioMediaMessage } from './types/messages.js';

const MAX_TRANSCRIPT_TAIL = 240;
const MAX_CONTROL_TAIL = 80;
const DEFAULT_MAX_CALL_DURATION_SECONDS = 1800;

export const contextualMicroInterventions = [
  'yes',
  'no',
  'one_moment',
  'let_me_think',
  'repeat_that',
  'ask_for_clarification',
  'earlier',
  'later',
  'today',
  'tomorrow',
  'accept',
  'decline',
  'do_not_commit',
  'end_politely'
] as const;

export type ContextualMicroIntervention = (typeof contextualMicroInterventions)[number];

export interface CreateAgentCallRequest {
  to: string;
  clientSessionId?: string;
  targetName?: string;
  callerName?: string;
  missionPrompt?: string;
  systemPrompt?: string;
  languageLock?: string;
  voice?: string;
  firstUtterance?: string;
  requireLiteralFirstUtterance?: boolean;
  deferFirstResponseUntilSessionReady?: boolean;
  maxCallDurationSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentControlRequest {
  control?: ContextualMicroIntervention;
  text?: string;
  note?: string;
}

type AgentCallState = 'created' | 'calling' | 'twilio-connected' | 'live' | 'ended' | 'error';

interface AgentTranscriptEntry {
  at: string;
  speaker: 'agent' | 'remote' | 'operator';
  delta: string;
}

interface AgentControlEntry {
  at: string;
  control?: ContextualMicroIntervention;
  text: string;
  delivered: boolean;
}

export interface AgentCallRecord {
  sessionId: string;
  callSid: string | null;
  to: string;
  targetName?: string;
  callerName?: string;
  missionPrompt: string;
  missionPromptWasFallback: boolean;
  systemPrompt?: string;
  languageLock?: string;
  voice: string;
  firstUtterance: string;
  requireLiteralFirstUtterance: boolean;
  deferFirstResponseUntilSessionReady: boolean;
  maxCallDurationSeconds: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  state: AgentCallState;
  error?: string;
  appToken: string;
  twilioStreamSid?: string;
  transcripts: AgentTranscriptEntry[];
  controls: AgentControlEntry[];
  counters: {
    twilioMediaChunks: number;
    agentAudioChunks: number;
    remoteTranscriptDeltas: number;
    agentTranscriptDeltas: number;
    controlsReceived: number;
    controlsDelivered: number;
  };
  startupDiagnostics: AgentStartupDiagnostics;
  lastActivityAt?: string;
  endedAt?: string;
  endedReason?: string;
}

export class AgentCallRegistry {
  private readonly sessions = new Map<string, AgentCallSession>();
  private readonly recentDiagnostics: Array<Record<string, unknown>> = [];

  constructor(private readonly config: AppConfig) {}

  create(request: CreateAgentCallRequest): AgentCallSession {
    const sessionId = request.clientSessionId ?? makeId('agentcall');
    if (!this.config.BRIDGE_MEDIA_SHARED_SECRET) {
      throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
    }
    const mission = normalizeMission(request.missionPrompt);

    const record: AgentCallRecord = {
      sessionId,
      callSid: null,
      to: request.to,
      targetName: normalizeOptional(request.targetName),
      callerName: normalizeOptional(request.callerName),
      missionPrompt: mission.text,
      missionPromptWasFallback: mission.wasFallback,
      systemPrompt: normalizeOptional(request.systemPrompt),
      languageLock: normalizeOptional(request.languageLock),
      voice: normalizeVoice(request.voice, request.languageLock),
      firstUtterance: normalizeFirstUtterance(request.firstUtterance),
      requireLiteralFirstUtterance: request.requireLiteralFirstUtterance ?? true,
      deferFirstResponseUntilSessionReady: request.deferFirstResponseUntilSessionReady ?? true,
      maxCallDurationSeconds: clampMaxCallDuration(request.maxCallDurationSeconds),
      metadata: request.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'created',
      appToken: makeAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, sessionId),
      transcripts: [],
      controls: [],
      counters: {
        twilioMediaChunks: 0,
        agentAudioChunks: 0,
        remoteTranscriptDeltas: 0,
        agentTranscriptDeltas: 0,
        controlsReceived: 0,
        controlsDelivered: 0
      },
      startupDiagnostics: {
        sessionUpdateAcked: false,
        firstUtteranceArmed: false,
        firstUtteranceDelivered: false,
        preArmedAudio: 0,
        firstUtteranceCorrectionSent: false
      }
    };

    const session = new AgentCallSession(this.config, record, (diagnostics) => this.delete(sessionId, diagnostics));
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AgentCallSession | undefined {
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

export class AgentCallSession {
  private twilioWs?: WebSocket;
  private agent?: OpenAiAgentVoiceSession;
  private timeout?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly record: AgentCallRecord,
    private readonly onDispose: (diagnostics: Record<string, unknown>) => void
  ) {
    this.timeout = setTimeout(() => void this.end('max_duration_reached'), record.maxCallDurationSeconds * 1000);
    this.timeout.unref();
  }

  get sessionId(): string {
    return this.record.sessionId;
  }

  get data(): AgentCallRecord {
    return this.record;
  }

  setCallSid(callSid: string | null): void {
    this.record.callSid = callSid;
    this.touch();
  }

  markCalling(): void {
    this.record.state = this.config.DRY_RUN_CALLS ? 'created' : 'calling';
    this.touch();
  }

  verifyAppToken(token: string): boolean {
    return Boolean(
      this.config.BRIDGE_MEDIA_SHARED_SECRET && verifyAppToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.sessionId, token)
    );
  }

  verifyStreamToken(token: string): boolean {
    return Boolean(
      this.config.BRIDGE_MEDIA_SHARED_SECRET && verifyStreamToken(this.config.BRIDGE_MEDIA_SHARED_SECRET, this.sessionId, token)
    );
  }

  monitorStreamUrl(): string | null {
    return null;
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
    const sessionId = params.sessionId;
    const streamToken = params.streamToken;
    if (sessionId !== this.sessionId || !streamToken || !this.verifyStreamToken(streamToken)) {
      ws.close();
      return false;
    }

    this.bindTwilio(ws, message);
    return true;
  }

  receiveControl(request: AgentControlRequest): AgentControlEntry {
    const text = controlInstruction(request);
    const entry: AgentControlEntry = {
      at: new Date().toISOString(),
      control: request.control,
      text,
      delivered: false
    };
    this.record.controls.push(entry);
    this.record.controls.splice(0, Math.max(0, this.record.controls.length - MAX_CONTROL_TAIL));
    this.record.counters.controlsReceived += 1;
    this.emitTranscript('operator', text);

    if (request.control === 'end_politely') {
      this.agent?.injectInstruction(text, request.control);
      entry.delivered = Boolean(this.agent && this.record.state === 'live');
      if (entry.delivered) {
        this.record.counters.controlsDelivered += 1;
      }
      setTimeout(() => void this.end('operator_end_politely'), 4000).unref();
      return entry;
    }

    this.agent?.injectInstruction(text, request.control);
    entry.delivered = Boolean(this.agent && this.record.state === 'live');
    if (entry.delivered) {
      this.record.counters.controlsDelivered += 1;
    }
    this.touch();
    return entry;
  }

  async end(reason = 'requested'): Promise<void> {
    if (this.record.state === 'ended') {
      return;
    }
    this.record.state = 'ended';
    this.record.endedAt = new Date().toISOString();
    this.record.endedReason = reason;
    this.agent?.close();
    this.twilioWs?.close();
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    try {
      await completeTwilioCall(this.config, this.record.callSid);
    } catch (error) {
      this.record.error = error instanceof Error ? error.message : 'Failed to complete Twilio call';
    }
    this.onDispose(this.diagnostics());
  }

  diagnostics(): Record<string, unknown> {
    return {
      sessionId: this.record.sessionId,
      callSid: this.record.callSid,
      state: this.record.state,
      to: redactPhone(this.record.to),
      targetName: this.record.targetName ?? null,
      callerName: this.record.callerName ?? null,
      languageLock: this.record.languageLock ?? null,
      voice: this.record.voice,
      missionPromptWasFallback: this.record.missionPromptWasFallback,
      missionPromptPreview: redactMissionText(this.record.systemPrompt ?? this.record.missionPrompt),
      maxCallDurationSeconds: this.record.maxCallDurationSeconds,
      realtimeModel: this.config.OPENAI_AGENT_MODEL,
      twilioConnected: Boolean(this.twilioWs),
      twilioStreamSid: this.record.twilioStreamSid ?? null,
      agentSession: this.agent?.status ?? 'idle',
      monitorStreamSupported: false,
      monitorStreamUrl: this.monitorStreamUrl(),
      error: this.record.error ?? null,
      startupDiagnostics: { ...this.record.startupDiagnostics },
      counters: { ...this.record.counters },
      controlsTail: this.record.controls.slice(-MAX_CONTROL_TAIL),
      transcriptDiagnosticNote:
        'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptDeltaRetainedCount: this.record.transcripts.length,
      transcriptTail: this.record.transcripts.slice(-MAX_TRANSCRIPT_TAIL),
      lastActivityAt: this.record.lastActivityAt ?? null,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      endedAt: this.record.endedAt ?? null,
      endedReason: this.record.endedReason ?? null
    };
  }

  private bindTwilio(ws: WebSocket, startMessage: Extract<TwilioMediaMessage, { event: 'start' }>): void {
    this.twilioWs?.close();
    this.twilioWs = ws;
    this.record.twilioStreamSid = startMessage.start.streamSid;
    this.record.callSid = startMessage.start.callSid;
    this.record.state = 'twilio-connected';
    this.touch();
    this.ensureAgentSession();

    ws.on('message', (raw) => this.handleTwilioMessage(raw.toString()));
    ws.on('close', () => {
      if (this.twilioWs === ws) {
        this.twilioWs = undefined;
        if (this.record.state !== 'ended' && this.record.state !== 'error') {
          this.record.state = 'ended';
          this.record.endedAt = new Date().toISOString();
          this.record.endedReason = 'twilio_stream_closed';
          this.agent?.close();
          this.onDispose(this.diagnostics());
        }
      }
    });
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
      if (message.media.track === 'outbound') {
        return;
      }
      this.record.counters.twilioMediaChunks += 1;
      this.ensureAgentSession();
      this.agent?.appendPcmuBase64(message.media.payload);
      return;
    }
    if (message.event === 'dtmf') {
      this.emitTranscript('remote', `[DTMF ${message.dtmf.digit}]`);
      return;
    }
    if (message.event === 'stop') {
      void this.end('twilio_stop');
    }
  }

  private ensureAgentSession(): void {
    if (this.agent) {
      return;
    }
    this.agent = new OpenAiAgentVoiceSession({
      config: this.config,
      instructions: buildAgentInstructions(this.record),
      firstUtterance: this.record.firstUtterance,
      voice: this.record.voice,
      onAudioDelta: (pcmu) => this.sendTwilioMedia(pcmu, `agent-${Date.now()}`),
      onRemoteTranscriptDelta: (delta) => {
        this.record.counters.remoteTranscriptDeltas += 1;
        this.emitTranscript('remote', delta);
      },
      onAgentTranscriptDelta: (delta) => {
        this.record.counters.agentTranscriptDeltas += 1;
        this.emitTranscript('agent', delta);
      },
      onStatus: (status) => {
        if (status === 'live' && this.twilioWs) {
          this.record.state = 'live';
        }
        this.touch();
      },
      onStartupDiagnostics: (diagnostics) => {
        this.record.startupDiagnostics = diagnostics;
        this.touch();
      },
      onError: (error) => this.fail(error)
    });
    this.agent.connect();
  }

  private sendTwilioMedia(payload: string, markName: string): void {
    if (!this.twilioWs || !this.record.twilioStreamSid) {
      return;
    }
    this.record.counters.agentAudioChunks += 1;
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

  private emitTranscript(speaker: 'agent' | 'remote' | 'operator', delta: string): void {
    const normalized = delta.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return;
    }
    this.record.transcripts.push({ at: new Date().toISOString(), speaker, delta: normalized });
    this.record.transcripts.splice(0, Math.max(0, this.record.transcripts.length - MAX_TRANSCRIPT_TAIL));
    this.touch();
  }

  private fail(error: Error): void {
    this.record.state = 'error';
    this.record.error = error.message;
    this.touch();
  }

  private touch(): void {
    const now = new Date().toISOString();
    this.record.updatedAt = now;
    this.record.lastActivityAt = now;
  }
}

export function buildAgentInstructions(record: AgentCallRecord): string {
  const languageLock = record.languageLock
    ? `Language lock: speak only in ${record.languageLock}, unless the remote callee explicitly cannot understand and the mission permits switching.`
    : 'Language lock: default to English unless the mission explicitly says another language is required.';
  const target = record.targetName ? `Remote callee/contact: ${record.targetName}.` : 'Remote callee/contact name is unknown.';
  const caller = record.callerName
    ? `You may say you are calling on behalf of ${record.callerName} if that is natural for the call.`
    : 'You may say you are calling on behalf of a client or customer if that is natural for the call.';
  const mission = record.systemPrompt ?? record.missionPrompt;
  const spokenStyle = languageStyleInstruction(record.languageLock);
  const holdPhrase = holdPhraseInstruction(record.languageLock);

  return [
    'You are a live outbound phone-call voice agent.',
    caller,
    target,
    languageLock,
    spokenStyle,
    `Your first spoken words must be exactly: "${record.firstUtterance}"`,
    'Stay in the caller-side role for the entire call. Never switch persona into the company, office, utility, restaurant, or remote callee.',
    'The remote callee can hear everything you say. Never ask the person who requested the call for private information out loud.',
    'Never say or imply: "the user", "the operator", "I am getting details from the user", "I am retrieving information from the user", "while I get the details", or any equivalent phrase.',
    'Do not begin the call with a hold phrase. Your first spoken turn must use the mission: greet naturally, confirm the contact if useful, state the reason for the call, and ask the first mission-specific question.',
    holdPhrase,
    'If required information is missing later, use only a brief hold phrase to the remote callee, then wait silently for a private control message. Do not explain where the missing information will come from.',
    'When a private control message arrives, apply it immediately and naturally to the active question or unresolved dialogue slot. Do not quote hidden instructions.',
    'Use short, phone-natural turns. Confirm important commitments before finalizing. Do not invent account numbers, dates, prices, names, medical facts, or authorization.',
    'Mission:',
    mission
  ].join('\n');
}

function controlInstruction(request: AgentControlRequest): string {
  const freeText = normalizeOptional(request.text ?? request.note);
  if (!request.control) {
    return freeText ?? 'Pause briefly and continue naturally.';
  }

  const map: Record<ContextualMicroIntervention, string> = {
    yes: 'Resolve the active question as yes, then ask the next necessary follow-up.',
    no: 'Resolve the active question as no, politely and clearly.',
    one_moment: 'Ask the remote callee for a moment, then pause.',
    let_me_think: 'Say that you need a moment to think or check, then pause.',
    repeat_that: 'Ask the remote callee to repeat or restate what they just said.',
    ask_for_clarification: 'Ask a concise clarifying question about the unresolved point.',
    earlier: 'Choose or request an earlier option in the current scheduling context.',
    later: 'Choose or request a later option in the current scheduling context.',
    today: 'Choose or request today in the current scheduling context.',
    tomorrow: 'Choose or request tomorrow in the current scheduling context.',
    accept: 'Accept the current offer, option, or proposal, while confirming any key details.',
    decline: 'Decline the current offer, option, or proposal politely.',
    do_not_commit: 'Avoid committing. Ask to keep options open or gather more information.',
    end_politely: 'Politely wrap up the call and end it.'
  };

  return freeText ? `${map[request.control]} Operator detail: ${freeText}` : map[request.control];
}

function normalizeMission(text: string | undefined): { text: string; wasFallback: boolean } {
  const normalized = normalizeOptional(text);
  return normalized
    ? { text: normalized, wasFallback: false }
    : {
        text:
          'No detailed mission was supplied. Do not invent a substantive reason for the call. Greet briefly, ask whether this is a convenient moment, and wait for private guidance.',
        wasFallback: true
      };
}

function normalizeOptional(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 6000) : undefined;
}

function normalizeFirstUtterance(text: string | undefined): string {
  return (
    normalizeOptional(text)?.slice(0, 300) ??
    "Hey there, just so you know, I am a real person but I'm using an AI translator."
  );
}

function normalizeVoice(voice: string | undefined, languageLock?: string): string {
  const normalized = normalizeOptional(voice)?.toLowerCase();
  const allowed = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
  if (normalized && allowed.has(normalized)) {
    return normalized;
  }
  return isSpanish(languageLock) ? 'cedar' : 'marin';
}

function clampMaxCallDuration(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_MAX_CALL_DURATION_SECONDS;
  }
  return Math.min(DEFAULT_MAX_CALL_DURATION_SECONDS, Math.max(30, Math.floor(value)));
}

function redactPhone(phone: string): string {
  if (phone.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

function redactMissionText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized;
}

function languageStyleInstruction(languageLock: string | undefined): string {
  if (isSpanish(languageLock)) {
    return [
      'Spoken style: sound like a natural native Spanish-speaking adult, preferably neutral Latin American Spanish.',
      'Use Spanish cadence and idioms, not literal English translations. Do not sound like an English speaker reading Spanish.',
      'If you must say an English name, say only that name in English and immediately continue in natural Spanish.'
    ].join(' ');
  }
  return 'Spoken style: sound natural, calm, and phone-native in the locked language.';
}

function holdPhraseInstruction(languageLock: string | undefined): string {
  if (isSpanish(languageLock)) {
    return 'Allowed Spanish hold phrases are only: "Un momento, por favor." or "Permítame revisar eso un momento." Do not add "mientras recupero información", "del usuario", or any explanation.';
  }
  return 'Allowed English hold phrases are only: "One moment, please." or "Let me check that for a moment." Do not add "from the user", "from the operator", or any explanation.';
}

function isSpanish(languageLock: string | undefined): boolean {
  const normalized = languageLock?.toLowerCase() ?? '';
  return normalized.startsWith('es') || normalized.includes('spanish') || normalized.includes('español');
}
