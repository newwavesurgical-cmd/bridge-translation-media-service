import WebSocket from 'ws';
import type { AppConfig } from '../config.js';

export type TranslationDirection = 'owner-to-remote' | 'remote-to-owner';
export type TranslationSessionStatus = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'error';

interface TranslationSessionOptions {
  config: AppConfig;
  targetLanguage: string;
  direction: TranslationDirection;
  onAudioDelta: (base64Pcm16: string) => void;
  onInputTranscriptDelta: (delta: string) => void;
  onOutputTranscriptDelta: (delta: string) => void;
  onStatus: (status: TranslationSessionStatus, detail?: string) => void;
  onError: (error: Error) => void;
}

export class OpenAiTranslationSession {
  private ws?: WebSocket;
  private statusValue: TranslationSessionStatus = 'idle';
  private readonly options: TranslationSessionOptions;
  private queuedAudio: string[] = [];

  constructor(options: TranslationSessionOptions) {
    this.options = options;
  }

  get status(): TranslationSessionStatus {
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
    const url = `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(
      this.options.config.OPENAI_TRANSLATION_MODEL
    )}`;

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
        session: buildTranslationSessionUpdate(this.options.targetLanguage)
      });
      for (const audio of this.queuedAudio.splice(0)) {
        this.appendPcm16Base64(audio);
      }
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

  appendPcm16Base64(base64Pcm16: string): void {
    if (this.statusValue === 'idle') {
      this.connect();
    }
    if (this.statusValue !== 'live') {
      this.queuedAudio.push(base64Pcm16);
      return;
    }
    this.sendJson({
      type: 'session.input_audio_buffer.append',
      audio: base64Pcm16
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
    this.sendJson({ type: 'session.close' });
    setTimeout(() => {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
      }
    }, 4000).unref();
  }

  private handleMessage(message: string): void {
    let event: { type?: string; delta?: string; error?: { message?: string } };
    try {
      event = JSON.parse(message) as { type?: string; delta?: string; error?: { message?: string } };
    } catch {
      return;
    }

    if (event.type === 'session.output_audio.delta' && event.delta) {
      this.options.onAudioDelta(event.delta);
      return;
    }
    if (event.type === 'session.input_transcript.delta' && event.delta) {
      this.options.onInputTranscriptDelta(event.delta);
      return;
    }
    if (event.type === 'session.output_transcript.delta' && event.delta) {
      this.options.onOutputTranscriptDelta(event.delta);
      return;
    }
    if (event.type === 'session.closed') {
      this.ws?.close();
      this.setStatus('closed');
      return;
    }
    if (event.type === 'error') {
      const error = new Error(event.error?.message ?? 'OpenAI realtime translation error');
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

  private setStatus(status: TranslationSessionStatus, detail?: string): void {
    this.statusValue = status;
    this.options.onStatus(status, detail);
  }
}

export function buildTranslationSessionUpdate(targetLanguage: string): Record<string, unknown> {
  return {
    audio: {
      input: {
        transcription: { model: 'gpt-realtime-whisper' },
        noise_reduction: { type: 'near_field' }
      },
      output: {
        language: openAiLanguageCode(targetLanguage)
      }
    }
  };
}

export function openAiLanguageCode(language: string): string {
  const normalized = language.trim().toLowerCase();
  const map: Record<string, string> = {
    english: 'en',
    en: 'en',
    spanish: 'es',
    es: 'es',
    french: 'fr',
    fr: 'fr',
    german: 'de',
    de: 'de',
    italian: 'it',
    it: 'it',
    portuguese: 'pt',
    pt: 'pt',
    chinese: 'zh',
    mandarin: 'zh',
    zh: 'zh',
    japanese: 'ja',
    ja: 'ja',
    korean: 'ko',
    ko: 'ko',
    arabic: 'ar',
    ar: 'ar',
    hindi: 'hi',
    hi: 'hi',
    russian: 'ru',
    ru: 'ru'
  };
  return map[normalized] ?? normalized;
}
