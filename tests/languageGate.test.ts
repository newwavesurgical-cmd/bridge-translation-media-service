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
    expect(classifyLanguage('Porque estaba duplicando la información. No entiendo por qué estaba duplicándola.')).toMatchObject({
      language: 'es'
    });
    expect(classifyLanguage('Tú enti endes lo que te estoy diciendo?')).toMatchObject({
      language: 'es'
    });
    expect(classifyLanguage('Ya no funciona. Sí, tengo dirección.')).toMatchObject({
      language: 'es'
    });
    expect(classifyLanguage('Eso sí me molesta.')).toMatchObject({
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

    expect(gate.shouldPassOutput()).toBe(false);
    expect(gate.observe('Hola, necesito una mesa para cuatro personas.')).toBe('suppress');
    expect(gate.shouldSuppressOutput()).toBe(true);
    expect(gate.shouldPassOutput()).toBe(false);
    expect(gate.diagnostics()).toMatchObject({
      suppressed: true,
      suppressionCount: 1
    });

    expect(gate.observe('Can you help me make a reservation for four people?')).toBe('pass');
    expect(gate.shouldSuppressOutput()).toBe(false);
    expect(gate.shouldPassOutput()).toBe(true);
  });

  it('classifies rolling transcript deltas instead of only the last fragment', () => {
    const gate = new TranscriptLanguageGate('English', 'soft_suppress');

    expect(gate.observe('Hola, necesito')).toBe('uncertain');
    expect(gate.observe(' una mesa para')).toBe('suppress');
    expect(gate.shouldSuppressOutput()).toBe(true);
    expect(gate.diagnostics().lastText).toContain('Hola, necesito una mesa para');
  });

  it('replaces stale mixed rolling text when a confident opposite-language turn begins', () => {
    const ownerGate = new TranscriptLanguageGate('English', 'soft_suppress');
    const partnerGate = new TranscriptLanguageGate('Spanish', 'soft_suppress');

    expect(ownerGate.observe("No, I'm not asking you anything ridiculous. It's common knowledge to be friendly.")).toBe(
      'pass'
    );
    expect(partnerGate.observe("No, I'm not asking you anything ridiculous. It's common knowledge to be friendly.")).toBe(
      'suppress'
    );

    expect(ownerGate.observe('Porque estaba duplicando la información. No entiendo por qué estaba duplicándola.')).toBe(
      'suppress'
    );
    expect(partnerGate.observe('Porque estaba duplicando la información. No entiendo por qué estaba duplicándola.')).toBe(
      'pass'
    );

    expect(ownerGate.shouldSuppressOutput()).toBe(true);
    expect(partnerGate.shouldSuppressOutput()).toBe(false);
    expect(ownerGate.diagnostics().lastText).not.toContain('common knowledge');
  });

  it('recognizes Spanish after logged English context with split realtime deltas', () => {
    const ownerGate = new TranscriptLanguageGate('English', 'soft_suppress');
    const partnerGate = new TranscriptLanguageGate('Spanish', 'soft_suppress');

    for (const delta of ["I've been talking to you for like 10 minutes", " and you're doing okay", ' but then you start having problems']) {
      expect(ownerGate.observe(delta)).not.toBe('suppress');
      partnerGate.observe(delta);
    }

    for (const delta of ['Tú ', 'enti', 'endes ', 'lo ', 'que ', 'te ', 'estoy ', 'diciendo?']) {
      ownerGate.observe(delta);
      partnerGate.observe(delta);
    }

    expect(ownerGate.shouldPassOutput()).toBe(false);
    expect(partnerGate.shouldPassOutput()).toBe(true);
    expect(partnerGate.diagnostics().lastText).toContain('diciendo');
  });
});
