import { describe, expect, it } from 'vitest';
import { classifyOperatorQuestion, stripQuestionFillers } from '../src/operatorQuestion.js';

describe('operator question classifier', () => {
  it('finds a filler-led scheduling proposal without punctuation', () => {
    expect(classifyOperatorQuestion('Oh, um, can we next Wednesday')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('treats offered appointment times as an operator choice', () => {
    expect(classifyOperatorQuestion('Um, we have 12 p.m. or 1 p.m.')).toMatchObject({
      kind: 'choice',
      blocking: true
    });
  });

  it('blocks an open scheduling question before the agent can improvise availability', () => {
    expect(classifyOperatorQuestion('What days are you thinking about coming in')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks the implicit day and bare time from the real car-showing exchange', () => {
    const mission = 'Find out if the car is available and schedule a time to come see it.';

    expect(classifyOperatorQuestion('Yeah, it sure would. Um, Wednesday', mission)).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
    expect(classifyOperatorQuestion('Yeah, it sure would. Um, Wednesday would be great', mission)).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
    expect(classifyOperatorQuestion('Uh. 1 p.m.', mission)).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks a bare streamed hour before a.m. or p.m. arrives', () => {
    const mission = 'Schedule a meeting on Wednesday.';

    for (const fragment of ['Twelve?', 'At twelve?', 'How about twelve?', '12', 'At 12']) {
      expect(classifyOperatorQuestion(fragment, mission), fragment).toMatchObject({
        kind: 'commitment',
        blocking: true
      });
    }
  });

  it('blocks a bare Spanish streamed hour in a scheduling mission', () => {
    expect(classifyOperatorQuestion('¿A las doce?', 'Llama para agendar una reunión.')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks direct meeting availability questions', () => {
    expect(classifyOperatorQuestion('When do you want to do the meeting?')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
    expect(classifyOperatorQuestion('Are you available on Wednesday?')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks Spanish day and time proposals in a scheduling mission', () => {
    const mission = 'Llama para agendar una reunión.';

    expect(classifyOperatorQuestion('El miércoles estaría bien.', mission)).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
    expect(classifyOperatorQuestion('A la 1 p. m.', mission)).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks a confirmation challenge even when twelve is transcribed as a word', () => {
    expect(classifyOperatorQuestion('Um, are you sure you can do twelve')).toMatchObject({
      kind: 'commitment',
      blocking: true
    });
  });

  it('blocks missing caller-side facts', () => {
    expect(classifyOperatorQuestion('Okay, how old is Peter please')).toMatchObject({
      kind: 'question',
      blocking: true
    });
  });

  it('lets the agent answer a caller-side fact that is explicitly present in mission memory', () => {
    expect(
      classifyOperatorQuestion('Okay, how old is Peter please', 'Patient: Peter. Age: 13 years old.'),
    ).toMatchObject({ kind: 'question', blocking: false });
  });

  it('keeps a general mission-answerable question nonblocking', () => {
    expect(classifyOperatorQuestion('Why are you calling today')).toMatchObject({
      kind: 'question',
      blocking: false
    });
  });

  it('ignores ordinary statements and acknowledgements', () => {
    expect(classifyOperatorQuestion('That sounds good.')).toBeNull();
    expect(classifyOperatorQuestion('Okay.')).toBeNull();
  });

  it('does not treat product availability as a scheduling authorization', () => {
    expect(classifyOperatorQuestion('It will be available Wednesday.', 'Ask whether the car is available.')).toBeNull();
  });

  it('does not treat a bare number as a time outside a scheduling mission', () => {
    expect(classifyOperatorQuestion('Twelve?', 'Ask about the warranty.')).toMatchObject({
      kind: 'question',
      blocking: false
    });
  });

  it('strips repeated English and Spanish fillers', () => {
    expect(stripQuestionFillers('Okay, um, well, what time works?')).toBe('what time works?');
    expect(stripQuestionFillers('Bueno, este, ¿qué día le sirve?')).toBe('¿qué día le sirve?');
  });
});
