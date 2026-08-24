import WebSocket from 'ws';
import type { AppConfig } from '../config.js';

export type AgentVoiceSessionStatus = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'error';

interface AgentVoiceSessionOptions {
  config: AppConfig;
  instructions: string;
  firstUtterance?: string;
  voice: string;
  onAudioDelta: (base64Pcmu: string) => void;
  onRemoteTranscriptDelta: (delta: string) => void;
  onAgentTranscriptDelta: (delta: string) => void;
  onStatus: (status: AgentVoiceSessionStatus, detail?: string) => void;
  onStartupDiagnostics?: (diagnostics: AgentStartupDiagnostics) => void;
  onError: (error: Error) => void;
}

export interface AgentStartupDiagnostics {
  sessionUpdateAcked: boolean;
  firstUtteranceArmed: boolean;
  firstUtteranceDelivered: boolean;
  preArmedAudio: number;
  firstUtteranceCorrectionSent: boolean;
}

const DEFAULT_FIRST_UTTERANCE =
  "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";
const POST_INTERVENTION_FOLLOWUP_MS = 3200;

export class OpenAiAgentVoiceSession {
  private ws?: WebSocket;
  private statusValue: AgentVoiceSessionStatus = 'idle';
  private readonly queuedAudio: string[] = [];
  private readonly guardedFirstAudio: string[] = [];
  private readonly guardedMissionAudio: string[] = [];
  private readonly guardedMissionTranscriptDeltas: string[] = [];
  private readonly instructions: string;
  private readonly firstUtterance: string;
  private hasStartedCall = false;
  private sessionUpdateAcked = false;
  private firstUtteranceArmed = false;
  private firstUtteranceDelivered = false;
  private firstUtteranceCorrectionSent = false;
  private firstUtteranceTranscript = '';
  private missionOpeningCorrectionSent = false;
  private missionOpeningTranscript = '';
  private preArmedAudio = 0;
  private responseActive = false;
  private pendingIntervention?: { text: string; semanticControl?: string };
  private postInterventionFollowup?: NodeJS.Timeout;
  private lastRemoteTranscriptAt = 0;
  private currentResponseKind: 'normal' | 'first_utterance' | 'mission_opening' | 'intervention' | 'post_intervention_followup' =
    'normal';

  constructor(private readonly options: AgentVoiceSessionOptions) {
    this.instructions = options.instructions;
    this.firstUtterance = normalizeFirstUtterance(options.firstUtterance ?? extractFirstUtterance(options.instructions));
  }

  get status(): AgentVoiceSessionStatus {
    return this.statusValue;
  }

  connect(): void {
    if (this.ws || this.statusValue === 'connecting' || this.statusValue === 'live') {
      return;
    }

    if (!this.options.config.OPENAI_API_KEY) {
      this.setStatus('error', 'OPENAI_API_KEY missing');
      this.options.onError(new Error('OPENAI_API_KEY missing'));
      return;
    }

    this.setStatus('connecting');
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.options.config.OPENAI_AGENT_MODEL)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.config.OPENAI_API_KEY}`,
        'OpenAI-Safety-Identifier': this.options.config.OPENAI_SAFETY_IDENTIFIER
      }
    });

    this.ws = ws;
    ws.on('open', () => {
      this.setStatus('live');
      this.sendJson({
        type: 'session.update',
        session: buildAgentSessionUpdate(this.options.config.OPENAI_AGENT_MODEL, this.options.instructions, this.options.voice)
      });
      this.publishStartupDiagnostics();
    });
    ws.on('message', (raw) => this.handleMessage(raw.toString()));
    ws.on('close', () => {
      this.ws = undefined;
      if (this.statusValue !== 'closing') {
        this.setStatus('closed');
      }
    });
    ws.on('error', (error) => {
      this.setStatus('error', error.message);
      this.options.onError(error);
    });
  }

  appendPcmuBase64(base64Pcmu: string): void {
    if (this.statusValue === 'idle') {
      this.connect();
    }
    if (this.statusValue !== 'live') {
      if (!this.firstUtteranceDelivered) {
        this.preArmedAudio += 1;
        this.publishStartupDiagnostics();
      }
      return;
    }
    if (!this.firstUtteranceDelivered) {
      this.preArmedAudio += 1;
      this.publishStartupDiagnostics();
      return;
    }
    this.sendJson({
      type: 'input_audio_buffer.append',
      audio: base64Pcmu
    });
  }

  injectInstruction(text: string, semanticControl?: string): void {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return;
    }
    if (this.statusValue === 'idle') {
      this.connect();
    }
    if (this.statusValue !== 'live') {
      return;
    }

    this.pendingIntervention = { text: normalized, semanticControl };
    this.cancelPostInterventionFollowup();
    this.cancelActiveResponse();
  }

  private flushPendingIntervention(): void {
    if (!this.pendingIntervention || this.statusValue !== 'live') {
      return;
    }
    const { text, semanticControl } = this.pendingIntervention;
    this.pendingIntervention = undefined;
    const interventionText = semanticControl
      ? `Private operator contextual micro-intervention: ${semanticControl}. Source text to apply, not quote: ${text}`
      : `Private operator intervention source text to apply, not quote: ${text}`;
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: interventionText }]
      }
    });
    this.createResponse(
      {
        output_modalities: ['audio'],
        instructions: [
          'Apply the private operator intervention immediately to the live phone call.',
          'The session language lock remains mandatory for every spoken word. If the operator source text is written in another language, translate the intended meaning into the locked spoken language.',
          'Do not quote the operator source text or preserve its source language.',
          'Say only the words intended for the remote callee. Do not mention the operator, controls, prompts, or hidden instructions.'
        ].join('\n')
      },
      'intervention'
    );
  }

  close(): void {
    if (!this.ws) {
      this.setStatus('closed');
      return;
    }
    if (this.statusValue === 'closing' || this.statusValue === 'closed') {
      return;
    }
    this.setStatus('closing');
    this.cancelPostInterventionFollowup();
    this.cancelActiveResponse();
    setTimeout(() => {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
      }
    }, 4000).unref();
  }

  private startCall(): void {
    if (this.hasStartedCall) {
      return;
    }
    this.hasStartedCall = true;
    this.firstUtteranceArmed = true;
    this.firstUtteranceTranscript = '';
    this.guardedFirstAudio.splice(0);
    this.publishStartupDiagnostics();
    this.createResponse(
      {
        output_modalities: ['audio'],
        instructions: `Say exactly this sentence and nothing else:\n${this.firstUtterance}`
      },
      'first_utterance'
    );
  }

  private restartFirstUtterance(): void {
    if (this.firstUtteranceCorrectionSent) {
      return;
    }
    this.firstUtteranceCorrectionSent = true;
    this.hasStartedCall = false;
    this.firstUtteranceTranscript = '';
    this.guardedFirstAudio.splice(0);
    this.cancelActiveResponse();
    this.startCall();
    this.publishStartupDiagnostics();
  }

  private handleMessage(message: string): void {
    let event: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      event = JSON.parse(message) as { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    } catch {
      return;
    }

    if (event.type === 'response.created') {
      this.responseActive = true;
      return;
    }
    if (event.type === 'response.output_audio.delta' && event.delta) {
      if (!this.firstUtteranceDelivered) {
        this.guardedFirstAudio.push(event.delta);
        return;
      }
      if (this.currentResponseKind === 'mission_opening') {
        this.guardedMissionAudio.push(event.delta);
        return;
      }
      this.options.onAudioDelta(event.delta);
      return;
    }
    if ((event.type === 'response.output_audio_transcript.delta' || event.type === 'response.output_text.delta') && event.delta) {
      if (!this.firstUtteranceDelivered) {
        this.firstUtteranceTranscript = normalizeTranscript(`${this.firstUtteranceTranscript}${event.delta}`);
        if (!isAllowedFirstUtterancePrefix(this.firstUtteranceTranscript, this.firstUtterance)) {
          this.restartFirstUtterance();
          return;
        }
      }
      if (this.currentResponseKind === 'mission_opening') {
        this.missionOpeningTranscript = normalizeTranscript(`${this.missionOpeningTranscript}${event.delta}`);
        this.guardedMissionTranscriptDeltas.push(event.delta);
        return;
      }
      this.options.onAgentTranscriptDelta(event.delta);
      return;
    }
    if (event.type?.includes('input_audio_transcription') && event.delta) {
      this.lastRemoteTranscriptAt = Date.now();
      this.cancelPostInterventionFollowup();
      this.options.onRemoteTranscriptDelta(event.delta);
      return;
    }
    if (event.type === 'session.closed') {
      this.ws?.close();
      this.setStatus('closed');
      return;
    }
    if (event.type === 'session.updated') {
      this.sessionUpdateAcked = true;
      this.publishStartupDiagnostics();
      this.startCall();
      return;
    }
    if (event.type === 'response.done') {
      this.responseActive = false;
      if (this.firstUtteranceArmed && !this.firstUtteranceDelivered) {
        if (!isCompleteFirstUtterance(this.firstUtteranceTranscript, this.firstUtterance)) {
          this.restartFirstUtterance();
          return;
        }
        this.firstUtteranceDelivered = true;
        for (const audio of this.guardedFirstAudio.splice(0)) {
          this.options.onAudioDelta(audio);
        }
        this.sendJson({
          type: 'session.update',
          session: {
            type: 'realtime',
            audio: {
              input: {
                turn_detection: realtimeTurnDetectionConfig(true)
              }
            }
          }
        });
        this.queuedAudio.splice(0);
        this.publishStartupDiagnostics();
        this.startMissionOpening();
        return;
      }
      if (this.currentResponseKind === 'mission_opening') {
        if (!this.isMissionOpeningAllowed()) {
          this.restartMissionOpening();
          return;
        }
        for (const delta of this.guardedMissionTranscriptDeltas.splice(0)) {
          this.options.onAgentTranscriptDelta(delta);
        }
        for (const audio of this.guardedMissionAudio.splice(0)) {
          this.options.onAudioDelta(audio);
        }
        this.missionOpeningTranscript = '';
      }
      this.flushPendingIntervention();
      if (this.currentResponseKind === 'intervention') {
        this.schedulePostInterventionFollowup();
      }
      this.currentResponseKind = 'normal';
      return;
    }
    if (event.type === 'response.cancelled') {
      this.responseActive = false;
      this.guardedMissionAudio.splice(0);
      this.guardedMissionTranscriptDeltas.splice(0);
      this.missionOpeningTranscript = '';
      this.flushPendingIntervention();
      this.currentResponseKind = 'normal';
      return;
    }
    if (event.type === 'error') {
      if (isNoActiveResponseCancelError(event.error?.message)) {
        this.responseActive = false;
        this.flushPendingIntervention();
        return;
      }
      if (isActiveResponseInProgressError(event.error?.message)) {
        this.responseActive = true;
        this.cancelActiveResponse();
        return;
      }
      const error = new Error(event.error?.message ?? 'OpenAI realtime agent error');
      this.setStatus('error', error.message);
      this.options.onError(error);
    }
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (isResponseCreate(payload)) {
      this.responseActive = true;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private startMissionOpening(): void {
    this.createResponse(
      {
        output_modalities: ['audio'],
        instructions: buildMissionOpeningInstructions(this.instructions)
      },
      'mission_opening'
    );
  }

  private restartMissionOpening(): void {
    if (this.missionOpeningCorrectionSent) {
      this.guardedMissionAudio.splice(0);
      this.guardedMissionTranscriptDeltas.splice(0);
      this.missionOpeningTranscript = '';
      return;
    }
    this.missionOpeningCorrectionSent = true;
    this.guardedMissionAudio.splice(0);
    this.guardedMissionTranscriptDeltas.splice(0);
    this.missionOpeningTranscript = '';
    this.createResponse(
      {
        output_modalities: ['audio'],
        instructions: buildMissionOpeningInstructions(this.instructions, true)
      },
      'mission_opening'
    );
  }

  private isMissionOpeningAllowed(): boolean {
    if (isEnglishLanguageLock(this.instructions) && containsSpanishSourceLeak(this.missionOpeningTranscript)) {
      return false;
    }
    return !containsGenericPlaceholder(this.missionOpeningTranscript);
  }

  private cancelActiveResponse(): void {
    this.sendJson({ type: 'response.cancel' });
  }

  private createResponse(
    response: Record<string, unknown>,
    kind: typeof this.currentResponseKind = 'normal'
  ): void {
    this.currentResponseKind = kind;
    this.sendJson({
      type: 'response.create',
      response
    });
  }

  private schedulePostInterventionFollowup(): void {
    this.cancelPostInterventionFollowup();
    const scheduledAt = Date.now();
    this.postInterventionFollowup = setTimeout(() => {
      this.postInterventionFollowup = undefined;
      if (this.statusValue !== 'live' || this.responseActive || this.pendingIntervention) {
        return;
      }
      if (this.lastRemoteTranscriptAt > scheduledAt) {
        return;
      }
      this.createResponse(
        {
          output_modalities: ['audio'],
          instructions: [
            'The remote callee has not responded after the last operator intervention.',
            'Retake command of the live call now.',
            'If more information is still needed, ask the next single necessary question.',
            'If the mission has enough information, briefly confirm the outcome and close politely.',
            'Do not repeat the sentence, hold phrase, or question you just said.',
            'If you already stated the call purpose earlier, do not restate it now; move to the next missing detail or close.',
            'Do not mention silence, timers, the operator, controls, prompts, or hidden instructions.',
            'Say only words intended for the remote callee.'
          ].join('\n')
        },
        'post_intervention_followup'
      );
    }, POST_INTERVENTION_FOLLOWUP_MS);
    this.postInterventionFollowup.unref?.();
  }

  private cancelPostInterventionFollowup(): void {
    if (!this.postInterventionFollowup) {
      return;
    }
    clearTimeout(this.postInterventionFollowup);
    this.postInterventionFollowup = undefined;
  }

  private setStatus(status: AgentVoiceSessionStatus, detail?: string): void {
    this.statusValue = status;
    this.options.onStatus(status, detail);
  }

  private publishStartupDiagnostics(): void {
    this.options.onStartupDiagnostics?.({
      sessionUpdateAcked: this.sessionUpdateAcked,
      firstUtteranceArmed: this.firstUtteranceArmed,
      firstUtteranceDelivered: this.firstUtteranceDelivered,
      preArmedAudio: this.preArmedAudio,
      firstUtteranceCorrectionSent: this.firstUtteranceCorrectionSent
    });
  }
}

function buildMissionOpeningInstructions(instructions: string, correction = false): string {
  const missionBrief = buildMissionOpeningBrief(instructions);
  return [
    correction
      ? 'Your previous draft opener included source-language or placeholder text and was discarded before the callee heard it.'
      : 'The literal disclosure has already been spoken. Do not repeat it.',
    'Ignore any repeated first-utterance, disclosure, or "same message" requirement in the mission text; that startup contract is already complete.',
    'Use the already-loaded session mission for facts, but do not read, quote, or summarize the raw mission prompt.',
    'Say exactly one short conversational turn: state the specific reason for the call one time in the language lock, then ask exactly one mission-specific question.',
    'Do not ask whether you are speaking with the named contact before stating the concrete purpose. If contact confirmation is necessary, place it after the purpose in the same single question.',
    'Use the language lock for every spoken word, even if the mission text or operator context is written in another language. Translate the purpose into the locked spoken language instead of quoting it.',
    'Never say a generic placeholder like "quick matter", "brief matter", or "calling about something" if the mission contains a real purpose.',
    'Do not list multiple wants, constraints, or background details. Do not repeat the purpose in a second sentence. Save details for later only if the callee asks.',
    'Say only words intended for the remote callee.',
    '',
    'Clean mission opening brief:',
    missionBrief
  ].join('\n');
}

function buildMissionOpeningBrief(instructions: string): string {
  const mission = extractMissionText(instructions);
  const cleaned = removeMissionScaffolding(mission);
  if (isEnglishLanguageLock(instructions) && containsSpanishSourceLeak(cleaned)) {
    return [
      'The source mission contains non-English purpose text.',
      'Use the concrete purpose from the already-loaded session mission, translated into natural English.',
      'Do not speak any source-language words or labels from the mission.'
    ].join(' ');
  }
  return cleaned || 'Use the concrete purpose from the already-loaded session mission and ask the next mission-specific question.';
}

function extractMissionText(instructions: string): string {
  const parts = instructions.split(/\nMission:\n/i);
  return normalizeTranscript(parts.length > 1 ? parts.at(-1) ?? instructions : instructions);
}

function removeMissionScaffolding(text: string): string {
  const withoutBlocks = text
    .replace(/===\s*OPERATOR LANGUAGE CONTEXT[\s\S]*?===\s*END OPERATOR LANGUAGE CONTEXT\s*===/gi, ' ')
    .replace(/===\s*FIRST UTTERANCE DISCLOSURE[\s\S]*?(?=(?:Goal|Objective|Purpose|Context|Mission|Task|Call|Objetivo|Propósito|Necesito|Quiero)\s*:|$)/gi, ' ');
  const cleaned = withoutBlocks
    .replace(/\bLANGUAGE LOCK\s*:[^.=]*(?:\.|$)/gi, ' ')
    .replace(/\bLITERAL FIRST UTTERANCE CONTRACT\s*:[^.]*(?:\.|$)/gi, ' ')
    .replace(/\bPURPOSE-SECOND RULE\s*:[^.]*(?:\.|$)/gi, ' ')
    .replace(/\bFIRST UTTERANCE\b[^.]*(?:\.|$)/gi, ' ')
    .replace(/\bYour VERY FIRST spoken words\b[^.]*(?:\.|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 700);
}

function isEnglishLanguageLock(instructions: string): boolean {
  return /\b(language lock:\s*speaks? only in\s*(?:en|english)|speak only english|first utterance must be in english)\b/i.test(
    instructions
  );
}

function containsSpanishSourceLeak(text: string): boolean {
  const normalized = compactLanguageText(text);
  return (
    /\bpedir\s+una\s+cita\b/.test(normalized) ||
    /\bcita\s+urgente\b/.test(normalized) ||
    /\bque\s+opero\b/.test(normalized) ||
    /\ba\s+su\s+hijo\b/.test(normalized) ||
    /\bhablar\s+con\b/.test(normalized) ||
    /\bpara\s+(?:pedir|hablar|llamar)\b/.test(normalized) ||
    /\b(?:necesito|quiero|usted|puede|podria|permiteme|gracias)\b/.test(normalized)
  );
}

function containsGenericPlaceholder(text: string): boolean {
  return /\b(?:quick matter|brief matter|calling about something)\b/i.test(text);
}

function compactLanguageText(text: string): string {
  return normalizeTranscript(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function buildAgentSessionUpdate(model: string, instructions: string, voice: string): Record<string, unknown> {
  return {
    type: 'realtime',
    model,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { type: 'audio/pcmu' },
        transcription: { model: 'gpt-realtime-whisper' },
        turn_detection: realtimeTurnDetectionConfig(false)
      },
      output: {
        format: { type: 'audio/pcmu' },
        voice
      }
    }
  };
}

function realtimeTurnDetectionConfig(createResponse: boolean): Record<string, unknown> {
  return {
    type: 'server_vad',
    threshold: 0.45,
    prefix_padding_ms: 250,
    silence_duration_ms: 350,
    create_response: createResponse,
    interrupt_response: true
  };
}

function extractFirstUtterance(instructions: string): string {
  const match = instructions.match(/VERY FIRST spoken words are EXACTLY this text, verbatim, in English:\s*"([^"]+)"/i);
  return match?.[1] ?? DEFAULT_FIRST_UTTERANCE;
}

function normalizeFirstUtterance(text: string): string {
  return text.replace(/\s+/g, ' ').trim() || DEFAULT_FIRST_UTTERANCE;
}

function normalizeTranscript(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
}

function isAllowedFirstUtterancePrefix(actual: string, expected: string): boolean {
  const normalizedActual = normalizeTranscript(actual).toLowerCase();
  const normalizedExpected = normalizeTranscript(expected).toLowerCase();
  const compactActual = compactTranscript(actual);
  const compactExpected = compactTranscript(expected);
  return (
    normalizedExpected.startsWith(normalizedActual) ||
    normalizedActual.startsWith(normalizedExpected) ||
    compactExpected.startsWith(compactActual) ||
    compactActual.startsWith(compactExpected)
  );
}

function isCompleteFirstUtterance(actual: string, expected: string): boolean {
  return (
    normalizeTranscript(actual).toLowerCase().startsWith(normalizeTranscript(expected).toLowerCase()) ||
    compactTranscript(actual).startsWith(compactTranscript(expected))
  );
}

function compactTranscript(text: string): string {
  return normalizeTranscript(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function isNoActiveResponseCancelError(message: string | undefined): boolean {
  return (message ?? '').toLowerCase().includes('cancellation failed: no active response found');
}

function isActiveResponseInProgressError(message: string | undefined): boolean {
  return (message ?? '').toLowerCase().includes('active response in progress');
}

function isResponseCreate(payload: unknown): payload is { type: 'response.create' } {
  return typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'response.create';
}
