const BIAS = 0x84;
const CLIP = 32635;

export function linearToMuLawSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function muLawToLinearSample(muLaw: number): number {
  muLaw = ~muLaw & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

export function encodeMuLaw(pcm16: Int16Array): Uint8Array {
  const output = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    output[i] = linearToMuLawSample(pcm16[i] ?? 0);
  }
  return output;
}

export function decodeMuLaw(muLaw: Uint8Array): Int16Array {
  const output = new Int16Array(muLaw.length);
  for (let i = 0; i < muLaw.length; i += 1) {
    output[i] = muLawToLinearSample(muLaw[i] ?? 0);
  }
  return output;
}
