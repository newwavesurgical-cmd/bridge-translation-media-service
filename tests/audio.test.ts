import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  makeDtmfMuLaw8kBase64,
  openAiPcm24kBase64ToTwilioMuLaw8kBase64,
  pcm16ToBase64,
  twilioMuLaw8kBase64ToOpenAiPcm24kBase64
} from '../src/audio/codec.js';
import { decodeMuLaw, encodeMuLaw } from '../src/audio/mulaw.js';
import { resampleLinearPcm16 } from '../src/audio/resample.js';

describe('audio codec boundary', () => {
  it('encodes and decodes mu-law without changing sample count', () => {
    const pcm = new Int16Array([-12000, -1000, 0, 1000, 12000]);
    const muLaw = encodeMuLaw(pcm);
    const decoded = decodeMuLaw(muLaw);

    expect(muLaw).toHaveLength(pcm.length);
    expect(decoded).toHaveLength(pcm.length);
    expect(Math.abs(decoded[2] ?? 999)).toBeLessThan(200);
  });

  it('resamples 8 kHz audio to 24 kHz and back', () => {
    const pcm8k = new Int16Array(160);
    for (let i = 0; i < pcm8k.length; i += 1) {
      pcm8k[i] = Math.round(Math.sin(i / 8) * 10000);
    }

    const pcm24k = resampleLinearPcm16(pcm8k, 8000, 24000);
    const roundTrip = resampleLinearPcm16(pcm24k, 24000, 8000);

    expect(pcm24k).toHaveLength(480);
    expect(roundTrip).toHaveLength(160);
  });

  it('converts Twilio mu-law/8k payload to OpenAI PCM16/24k payload and back', () => {
    const pcm24k = new Int16Array(480);
    for (let i = 0; i < pcm24k.length; i += 1) {
      pcm24k[i] = Math.round(Math.sin(i / 12) * 8000);
    }

    const twilioPayload = openAiPcm24kBase64ToTwilioMuLaw8kBase64(pcm16ToBase64(pcm24k));
    const openAiPayload = twilioMuLaw8kBase64ToOpenAiPcm24kBase64(twilioPayload);

    expect(base64ToBytes(twilioPayload)).toHaveLength(160);
    expect(base64ToBytes(openAiPayload)).toHaveLength(960);
  });

  it('generates in-band DTMF tone payloads for IVR keypad testing', () => {
    const payload = makeDtmfMuLaw8kBase64('1', 180);
    expect(base64ToBytes(payload)).toHaveLength(1440);
  });
});
