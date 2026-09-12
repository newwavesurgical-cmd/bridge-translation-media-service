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

  it('strips repeated English and Spanish fillers', () => {
    expect(stripQuestionFillers('Okay, um, well, what time works?')).toBe('what time works?');
    expect(stripQuestionFillers('Bueno, este, ¿qué día le sirve?')).toBe('¿qué día le sirve?');
  });
});
