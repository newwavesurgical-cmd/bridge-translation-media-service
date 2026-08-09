import { describe, expect, it } from 'vitest';
import { buildTranslationSessionUpdate, openAiLanguageCode } from '../src/openai/translationSession.js';

describe('OpenAI translation session language codes', () => {
  it('normalizes common display labels to language codes', () => {
    expect(openAiLanguageCode('English')).toBe('en');
    expect(openAiLanguageCode('Spanish')).toBe('es');
    expect(openAiLanguageCode('Portuguese')).toBe('pt');
  });

  it('preserves already coded or unknown language values', () => {
    expect(openAiLanguageCode('es')).toBe('es');
    expect(openAiLanguageCode('ca')).toBe('ca');
  });

  it('configures input transcription and noise reduction for diagnostics and phone audio', () => {
    expect(buildTranslationSessionUpdate('Spanish')).toEqual({
      audio: {
        input: {
          transcription: { model: 'gpt-realtime-whisper' },
          noise_reduction: { type: 'near_field' }
        },
        output: {
          language: 'es'
        }
      }
    });
  });
});
