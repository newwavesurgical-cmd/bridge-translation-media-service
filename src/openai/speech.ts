import type { AppConfig } from '../config.js';

interface SpeechOptions {
  text: string;
  language: string;
}

export async function createSpeechPcm24kBase64(config: AppConfig, options: SpeechOptions): Promise<string> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': config.OPENAI_SAFETY_IDENTIFIER
    },
    body: JSON.stringify({
      model: config.OPENAI_TTS_MODEL,
      voice: config.OPENAI_TTS_VOICE,
      input: options.text,
      instructions: `Speak naturally in ${options.language}. Keep the pacing conversational for a phone call.`,
      response_format: 'pcm',
      speed: 1.05
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI speech failed: ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ''}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return Buffer.from(bytes).toString('base64');
}
