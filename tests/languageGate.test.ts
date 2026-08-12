import { describe, expect, it } from 'vitest';
import { classifyLanguage, TranscriptLanguageGate } from '../src/languageGate.js';

describe('TranscriptLanguageGate', () => {
  it('classifies clear English and Spanish transcript fragments', () => {
    expect(classifyLanguage('Can you help me make a reservation for four people?')).toMatchObject({
      language: 'en'
    });
    expect(classifyLanguage('Hola, necesito una mesa para cuatro personas.')).toMatchObject({
      language: 'es'
    });
  });

  it('keeps short or universal fragments uncertain', () => {
    expect(classifyLanguage('OK')).toMatchObject({ language: null });
    expect(classifyLanguage('Sí, ok')).toMatchObject({ language: null });
  });

  it('monitors wrong-language pickup without suppressing output by default', () => {
    const gate = new TranscriptLanguageGate('English', 'monitor');

    expect(gate.observe('Hola, necesito una mesa para cuatro personas.')).toBe('monitor');
    expect(gate.shouldSuppressOutput()).toBe(false);
    expect(gate.diagnostics()).toMatchObject({
      mode: 'monitor',
      expectedLanguage: 'English',
      detectedLanguage: 'es',
      suppressed: false,
      suppressionCount: 0
    });
  });

  it('soft suppresses confidently wrong-language pickup', () => {
    const gate = new TranscriptLanguageGate('English', 'soft_suppress');

    expect(gate.observe('Hola, necesito una mesa para cuatro personas.')).toBe('suppress');
    expect(gate.shouldSuppressOutput()).toBe(true);
    expect(gate.diagnostics()).toMatchObject({
      suppressed: true,
      suppressionCount: 1
    });

    expect(gate.observe('Can you help me make a reservation for four people?')).toBe('pass');
    expect(gate.shouldSuppressOutput()).toBe(false);
  });

  it('classifies rolling transcript deltas instead of only the last fragment', () => {
    const gate = new TranscriptLanguageGate('English', 'soft_suppress');

    expect(gate.observe('Hola, necesito')).toBe('uncertain');
    expect(gate.observe(' una mesa para')).toBe('suppress');
    expect(gate.shouldSuppressOutput()).toBe(true);
    expect(gate.diagnostics().lastText).toContain('Hola, necesito una mesa para');
  });
});
