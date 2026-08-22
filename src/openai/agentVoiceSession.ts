import WebSocket from 'ws';
import type { AppConfig } from '../config.js';

export type AgentVoiceSessionStatus = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'error';

interface AgentVoiceSessionOptions {
  config: AppConfig;
  instructions: string;
  voice: string;
  onAudioDelta: (base64Pcmu: string) => void;
  onRemoteTranscriptDelta: (delta: string) => void;
  onAgentTranscriptDelta: (delta: string) => void;
  onStatus: (status: AgentVoiceSessionStatus, detail?: string) => void;
  onError: (error: Error) => void;
}

export class OpenAiAgentVoiceSession {
  private ws?: WebSocket;
  private statusValue: AgentVoiceSessionStatus = 'idle';
  private readonly queuedAudio: string[] = [];
  private hasStartedCall = false;

  constructor(private readonly options: AgentVoiceSessionOptions) {}

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
      for (const audio of this.queuedAudio.splice(0)) {
        this.appendPcmuBase64(audio);
      }
      this.startCall();
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
      this.queuedAudio.push(base64Pcmu);
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

    this.sendJson({ type: 'response.cancel' });
    const interventionText = semanticControl
      ? `Operator contextual micro-intervention: ${semanticControl}. ${normalized}`
      : `Operator intervention: ${normalized}`;
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: interventionText }]
      }
    });
    this.sendJson({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions:
          'Apply the operator intervention immediately to the live phone call. Say only the words intended for the remote callee. Do not mention the operator, controls, prompts, or hidden instructions.'
      }
    });
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
    this.sendJson({ type: 'response.cancel' });
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
    this.sendJson({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions:
          'Begin the outbound phone call now. Your first turn must be a mission-specific greeting and question. Do not begin with a hold phrase. Do not mention a user, operator, hidden prompt, missing details, or that you are retrieving information. If the language lock is Spanish, speak like a natural native Spanish speaker.'
      }
    });
  }

  private handleMessage(message: string): void {
    let event: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      event = JSON.parse(message) as { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    } catch {
      return;
    }

    if (event.type === 'response.output_audio.delta' && event.delta) {
      this.options.onAudioDelta(event.delta);
      return;
    }
    if ((event.type === 'response.output_audio_transcript.delta' || event.type === 'response.output_text.delta') && event.delta) {
      this.options.onAgentTranscriptDelta(event.delta);
      return;
    }
    if (event.type?.includes('input_audio_transcription') && event.delta) {
      this.options.onRemoteTranscriptDelta(event.delta);
      return;
    }
    if (event.type === 'session.closed') {
      this.ws?.close();
      this.setStatus('closed');
      return;
    }
    if (event.type === 'error') {
      const error = new Error(event.error?.message ?? 'OpenAI realtime agent error');
      this.setStatus('error', error.message);
      this.options.onError(error);
    }
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private setStatus(status: AgentVoiceSessionStatus, detail?: string): void {
    this.statusValue = status;
    this.options.onStatus(status, detail);
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
        turn_detection: { type: 'semantic_vad' }
      },
      output: {
        format: { type: 'audio/pcmu' },
        voice
      }
    }
  };
}
