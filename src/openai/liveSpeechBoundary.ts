import { decodeMuLaw } from '../audio/mulaw.js';

/** Local output activity detection, not ASR. Live can stream silence forever. */
export class LiveSpeechBoundary {
  quietMs = 0;

  append(base64Pcmu: string): { voiced: boolean; endsQuiet: boolean } {
    const pcm = decodeMuLaw(Buffer.from(base64Pcmu, 'base64'));
    let voiced = false;
    // Inspect 20 ms frames so a large chunk's trailing silence is not hidden
    // by its average energy. PCMU is always 8 kHz in this adapter.
    for (let offset = 0; offset < pcm.length; offset += 160) {
      const frame = pcm.subarray(offset, offset + 160);
      const energy = frame.reduce((sum, sample) => sum + sample * sample, 0);
      if (Math.sqrt(energy / frame.length) >= 180) {
        voiced = true;
        this.quietMs = 0;
      } else {
        this.quietMs += frame.length / 8;
      }
    }
    return { voiced, endsQuiet: this.quietMs >= 450 };
  }
}
