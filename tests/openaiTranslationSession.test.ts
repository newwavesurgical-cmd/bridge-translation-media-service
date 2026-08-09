import { describe, expect, it } from 'vitest';
import { openAiLanguageCode } from '../src/openai/translationSession.js';

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
});
