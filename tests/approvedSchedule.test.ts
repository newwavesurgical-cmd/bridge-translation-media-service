import { describe, expect, it } from 'vitest';
import { isApprovedScheduleRecall, rememberApprovedSchedule, startsNewSchedule } from '../src/approvedSchedule.js';

const approved = { day: 'Wednesday', time: '4:00PM' };

describe('approved scheduling facts', () => {
  it('retains delivered day and time values separately, including a choice from alternatives', () => {
    const day = rememberApprovedSchedule({}, 'Wednesday or Thursday?', 'Wednesday', 'relay_value');
    expect(day).toEqual({ day: 'Wednesday' });
    const bareTime = rememberApprovedSchedule(day, 'What time should I say you will come, within 1–5 p.m.?', '4', 'relay_value');
    expect(bareTime).toEqual({ day: 'Wednesday', time: '4:00' });
    expect(rememberApprovedSchedule(bareTime, 'What day and time would you like?', '4 PM', 'relay_value')).toEqual(approved);
  });

  it('captures a positive answer to one concrete offer, but not to multiple choices', () => {
    expect(rememberApprovedSchedule({}, 'Can you come Wednesday at 4 p.m.?', 'Yes', 'yes')).toEqual(approved);
    expect(rememberApprovedSchedule({}, 'Wednesday or Thursday?', 'Yes', 'yes')).toEqual({});
    expect(rememberApprovedSchedule({}, 'At 4 p.m. or 5 p.m.?', 'Yes', 'yes')).toEqual({});
    expect(rememberApprovedSchedule({}, 'Wednesday at noon?', 'Yes', 'yes')).toEqual({ day: 'Wednesday', time: '12:00PM' });
  });

  it.each(['I am available until 3 PM', 'Can you come after 4 PM?', 'Before Wednesday?', 'Around 4 PM?'])('does not flatten a boundary or approximate offer into an exact approval: %s', (question) => {
    expect(rememberApprovedSchedule({}, question, 'Yes', 'yes')).toEqual({});
  });

  it.each(['no', 'decline', 'do_not_commit', 'earlier', 'later', 'one_moment'])('does not turn %s into approval', (semantic) => {
    expect(rememberApprovedSchedule({}, 'Wednesday at 4 p.m.?', 'Wednesday 4 p.m.', semantic)).toEqual({});
  });

  it.each(['Maybe Wednesday at 4 PM', '4 PM will not work', "4 PM won't work", '4 PM if they waive the fee'])('does not memorize conditional or rejected value: %s', (reply) => {
    expect(rememberApprovedSchedule({}, 'What time works?', reply, 'relay_value')).toEqual({});
  });

  it('does not mistake a caller age or quantity for an approved meeting hour', () => {
    expect(rememberApprovedSchedule({}, 'How old is your child?', '4', 'relay_value')).toEqual({});
    expect(rememberApprovedSchedule({}, 'How many owners has it had?', 'One', 'relay_value')).toEqual({});
  });

  it('invalidates the previous time when an operator approves a different day', () => {
    expect(rememberApprovedSchedule(approved, 'What day can you come?', 'Thursday', 'relay_value')).toEqual({ day: 'Thursday' });
    expect(startsNewSchedule('Can we book another appointment?')).toBe(true);
    expect(startsNewSchedule('Una nueva cita')).toBe(true);
  });

  it('normalizes Spanish supplied values without guessing AM/PM', () => {
    const day = rememberApprovedSchedule({}, '¿Qué día puede venir?', 'miércoles', 'relay_value');
    expect(rememberApprovedSchedule(day, '¿A qué hora?', 'cuatro de la tarde', 'relay_value')).toEqual(approved);
    expect(rememberApprovedSchedule(day, '¿A qué hora?', 'cuatro', 'relay_value')).toEqual({ day: 'Wednesday', time: '4:00' });
  });
});

describe('recap versus new scheduling decision', () => {
  it.each([
    'What time are we going to meet?', 'Okay, what time do we agree on?',
    "so what's the plan, what's the date? When are we meeting", 'date',
    "Okay, let's confirm the time.", 'We already agreed on a time and a date.',
    'Wednesday at 4 PM, right?', 'Wednesday at four?', 'At 4:00 p.m.?',
    '¿A qué hora vamos a reunirnos?', '¿Cuál era la fecha?',
    '¿Entonces nos vemos el miércoles a las cuatro de la tarde?',
    'Confirmemos la hora.', 'What time', 'What time are we'
  ])('allows a recap of the same approved arrangement: %s', (text) => {
    expect(isApprovedScheduleRecall(text, approved)).toBe(true);
  });

  it.each([
    'What about Thursday?', 'Wednesday at 5 PM?', 'Wednesday at 4 AM?',
    'Wednesday at 4:30 PM?', 'Wednesday at 4 PM Eastern?',
    'Next Wednesday at 4 PM?', 'Wednesday September 23 at 4 PM?',
    'Wednesday at 4 PM and pay $50?', 'Wednesday at 4 PM every week?',
    'Can we book another meeting Wednesday at 4 PM?',
    'Can we cancel Wednesday at 4 PM?', 'Is 4 PM okay instead?',
    "Wednesday doesn't work", 'What time and what price?',
    'What time are we meeting at the other location?',
    '¿El jueves a las cuatro?', '¿Podemos cambiar la hora?',
    '¿El miércoles a las cuatro de la mañana?', 'How old is he?'
  ])('keeps new, changed, mixed, or ambiguous commitments on the approval path: %s', (text) => {
    expect(isApprovedScheduleRecall(text, approved)).toBe(false);
  });

  it('does not create missing facts from a recap, another call, or the agent transcript', () => {
    expect(isApprovedScheduleRecall('What time are we meeting?', { day: 'Wednesday' })).toBe(false);
    expect(isApprovedScheduleRecall('What day was it?', { time: '4:00PM' })).toBe(false);
    expect(isApprovedScheduleRecall('Wednesday at 4 PM?', {})).toBe(false);
    expect(isApprovedScheduleRecall('Wednesday at 4 PM?', { day: 'Wednesday', time: '4:00' })).toBe(false);
  });
});
