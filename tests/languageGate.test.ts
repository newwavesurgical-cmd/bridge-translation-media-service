import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyLanguage, TranscriptLanguageGate } from '../src/languageGate.js';

describe('TranscriptLanguageGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(classifyLanguage('Esa es una historia muy linda. ¿Qué está pasando aquí?')).toMatchObject({
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
    expect(gate.diagnostics()).toMatchObject({
      passFresh: true
    });
  });

  it('does not allow stale same-language passes to authorize a new auto turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const gate = new TranscriptLanguageGate('English', 'soft_suppress');

    expect(gate.observe('Can you help me make a reservation for four people?')).toBe('pass');
    expect(gate.shouldPassOutput()).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(gate.shouldPassOutput()).toBe(true);

    vi.advanceTimersByTime(8000);

    expect(gate.shouldPassOutput()).toBe(false);
    expect(gate.diagnostics()).toMatchObject({
      decision: 'pass',
      passFresh: false
    });
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const ownerGate = new TranscriptLanguageGate('English', 'soft_suppress');
    const partnerGate = new TranscriptLanguageGate('Spanish', 'soft_suppress');

    for (const delta of ["I've been talking to you for like 10 minutes", " and you're doing okay", ' but then you start having problems']) {
      expect(ownerGate.observe(delta)).not.toBe('suppress');
      partnerGate.observe(delta);
      vi.advanceTimersByTime(100);
    }

    vi.advanceTimersByTime(13000);
    expect(ownerGate.shouldPassOutput()).toBe(false);

    for (const delta of ['Tú ', 'enti', 'endes ', 'lo ', 'que ', 'te ', 'estoy ', 'diciendo?']) {
      ownerGate.observe(delta);
      partnerGate.observe(delta);
      vi.advanceTimersByTime(80);
    }

    expect(ownerGate.shouldPassOutput()).toBe(false);
    expect(partnerGate.shouldPassOutput()).toBe(true);
    expect(partnerGate.diagnostics().lastText).toContain('diciendo');
  });

  it('does not keep English output open when a later Spanish turn starts after a pause', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const ownerGate = new TranscriptLanguageGate('English', 'soft_suppress');
    const partnerGate = new TranscriptLanguageGate('Spanish', 'soft_suppress');

    expect(ownerGate.observe('This is a long English passage about a restaurant reservation and what happens next.')).toBe(
      'pass'
    );
    partnerGate.observe('This is a long English passage about a restaurant reservation and what happens next.');
    expect(ownerGate.shouldPassOutput()).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(ownerGate.shouldPassOutput()).toBe(true);

    vi.advanceTimersByTime(8000);

    expect(ownerGate.shouldPassOutput()).toBe(false);
    ownerGate.observe('Eso sí me molesta. ¿Qué está pasando?');
    partnerGate.observe('Eso sí me molesta. ¿Qué está pasando?');

    expect(ownerGate.shouldPassOutput()).toBe(false);
    expect(partnerGate.shouldPassOutput()).toBe(true);
  });

  it('closes the old English pass immediately when a clear Spanish story turn starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const ownerGate = new TranscriptLanguageGate('English', 'soft_suppress');
    const partnerGate = new TranscriptLanguageGate('Spanish', 'soft_suppress');

    expect(ownerGate.observe('Are you ready to get to work?')).toBe('pass');
    partnerGate.observe('Are you ready to get to work?');
    vi.advanceTimersByTime(1000);
    expect(ownerGate.shouldPassOutput()).toBe(true);

    expect(ownerGate.observe('Esa es una historia muy linda. ¿Qué está pasando aquí?')).toBe('suppress');
    expect(partnerGate.observe('Esa es una historia muy linda. ¿Qué está pasando aquí?')).toBe('pass');
    expect(ownerGate.shouldPassOutput()).toBe(false);
    expect(partnerGate.shouldPassOutput()).toBe(true);
  });
});
