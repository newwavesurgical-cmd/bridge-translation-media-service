import { decodeMuLaw, encodeMuLaw } from './mulaw.js';
import { resampleLinearPcm16 } from './resample.js';

export function base64ToBytes(base64: string): Uint8Array {
  return Buffer.from(base64, 'base64');
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function pcm16ToBase64(pcm16: Int16Array): string {
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
}

export function base64ToPcm16(base64: string): Int16Array {
  const buffer = Buffer.from(base64, 'base64');
  return new Int16Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function twilioMuLaw8kBase64ToOpenAiPcm24kBase64(payload: string): string {
  const muLaw = base64ToBytes(payload);
  const pcm8k = decodeMuLaw(muLaw);
  const pcm24k = resampleLinearPcm16(pcm8k, 8000, 24000);
  return pcm16ToBase64(pcm24k);
}

export function openAiPcm24kBase64ToTwilioMuLaw8kBase64(payload: string): string {
  const pcm24k = base64ToPcm16(payload);
  const pcm8k = resampleLinearPcm16(pcm24k, 24000, 8000);
  const muLaw = encodeMuLaw(pcm8k);
  return bytesToBase64(muLaw);
}

export function makeDtmfMuLaw8kBase64(digit: string, durationMs = 180, sampleRate = 8000): string {
  const freqs = dtmfFrequencies(digit);
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const value = (Math.sin(2 * Math.PI * freqs[0] * t) + Math.sin(2 * Math.PI * freqs[1] * t)) * 0.22;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return bytesToBase64(encodeMuLaw(pcm));
}

function dtmfFrequencies(digit: string): [number, number] {
  const table: Record<string, [number, number]> = {
    '1': [697, 1209],
    '2': [697, 1336],
    '3': [697, 1477],
    '4': [770, 1209],
    '5': [770, 1336],
    '6': [770, 1477],
    '7': [852, 1209],
    '8': [852, 1336],
    '9': [852, 1477],
    '*': [941, 1209],
    '0': [941, 1336],
    '#': [941, 1477]
  };
  const freqs = table[digit];
  if (!freqs) {
    throw new Error(`Unsupported DTMF digit: ${digit}`);
  }
  return freqs;
}
