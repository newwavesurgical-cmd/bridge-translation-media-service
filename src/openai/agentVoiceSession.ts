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

const DEFAULT_FIRST_UTTERANCE = "Hey there, just so you know, I am a real person but I'm using an AI translator.";
const POST_INTERVENTION_FOLLOWUP_MS = 3200;

export class OpenAiAgentVoiceSession {
  private ws?: WebSocket;
  private statusValue: AgentVoiceSessionStatus = 'idle';
  private readonly queuedAudio: string[] = [];
  private readonly guardedFirstAudio: string[] = [];
  private readonly instructions: string;
  private readonly firstUtterance: string;
  private hasStartedCall = false;
  private sessionUpdateAcked = false;
  private firstUtteranceArmed = false;
  private firstUtteranceDelivered = false;
  private firstUtteranceCorrectionSent = false;
  private firstUtteranceTranscript = '';
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
      ? `Operator contextual micro-intervention: ${semanticControl}. ${text}`
      : `Operator intervention: ${text}`;
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
        instructions:
          'Apply the operator intervention immediately to the live phone call. Say only the words intended for the remote callee. Do not mention the operator, controls, prompts, or hidden instructions.'
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
      this.flushPendingIntervention();
      if (this.currentResponseKind === 'intervention') {
        this.schedulePostInterventionFollowup();
      }
      this.currentResponseKind = 'normal';
      return;
    }
    if (event.type === 'response.cancelled') {
      this.responseActive = false;
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
        instructions: [
          'The literal disclosure has already been spoken. Do not repeat it.',
          'Ignore any repeated first-utterance, disclosure, or "same message" requirement in the mission text below; that startup contract is already complete.',
          'Continue the outbound phone call now using the mission and standing instructions below, but do not read or summarize the whole mission.',
          'Say exactly one short conversational turn: state the specific reason for the call in the language lock, then ask exactly one mission-specific question.',
          'Use the language lock for every spoken word, even if the mission text or operator context is written in another language. Translate the purpose into the locked spoken language instead of quoting it.',
          'Do not say a generic placeholder like "quick matter" if the mission contains a real purpose.',
          'Do not list multiple wants, constraints, or background details. Save those for later only if the callee asks.',
          'Say only words intended for the remote callee.',
          '',
          this.instructions
        ].join('\n')
      },
      'mission_opening'
    );
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
