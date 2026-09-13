/** Call-local facts supplied by delivered operator answers, never by agent claims. */
export interface ApprovedSchedule {
  day?: string;
  time?: string;
}

const DAYS: Record<string, string> = {
  monday: 'Monday', lunes: 'Monday', tuesday: 'Tuesday', martes: 'Tuesday',
  wednesday: 'Wednesday', miercoles: 'Wednesday', thursday: 'Thursday', jueves: 'Thursday',
  friday: 'Friday', viernes: 'Friday', saturday: 'Saturday', sabado: 'Saturday',
  sunday: 'Sunday', domingo: 'Sunday'
};
const HOURS: Record<string, number> = {
  one: 1, uno: 1, una: 1, two: 2, dos: 2, three: 3, tres: 3, four: 4, cuatro: 4,
  five: 5, cinco: 5, six: 6, seis: 6, seven: 7, siete: 7, eight: 8, ocho: 8,
  nine: 9, nueve: 9, ten: 10, diez: 10, eleven: 11, once: 11, twelve: 12, doce: 12
};
const DAY_RE = new RegExp(`\\b(${Object.keys(DAYS).join('|')})(?:s)?\\b`, 'g');
const TIME_RE = new RegExp(`\\b(\\d{1,2}|${Object.keys(HOURS).join('|')})(?::(\\d{2}))?(?:\\s*(a\\s*m|p\\s*m|de la manana|de la tarde|de la noche))?\\b`, 'g');
const SCHEDULE_TOPIC = /\b(day|date|time|when|meet|meeting|visit|viewing|appointment|available|availability|come|hora|dia|fecha|cuando|reunion|cita|venir|visita|disponible)\b/;
const CHANGE = /\b(change|instead|reschedule|cancel|different|another|second|additional|new|not|cannot|can't|won't|don't|doesn't|isn't|no|cambiar|cambio|reprogramar|cancelar|otra|otro|nueva|nuevo|distint[oa])\b/;
const UNSUPPORTED_DATE = /\b(next|this|today|tomorrow|tonight|week|month|year|proximo|proxima|este|esta|hoy|manana|semana|mes|ano)\b|\d[/-]\d/;

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'").replace(/([ap])\s*\.\s*m\.?/g, '$1m')
    .replace(/\s+/g, ' ').trim();
}

function slots(text: string): { days: string[]; times: string[]; rest: string } {
  const days: string[] = [];
  const times: string[] = [];
  let rest = normalize(text).replace(DAY_RE, (_word, day: string) => {
    days.push(DAYS[day]);
    return ' ';
  });
  rest = rest.replace(/\b(noon|mediodia|midnight|medianoche)\b/g, (_word, value: string) => {
    times.push(/^(noon|mediodia)$/.test(value) ? '12:00PM' : '12:00AM');
    return ' ';
  });
  rest = rest.replace(TIME_RE, (word, hour: string, minutes?: string, period?: string) => {
    const h = HOURS[hour] ?? Number(hour);
    const m = Number(minutes ?? 0);
    if (h < 1 || h > 12 || m > 59) return word;
    const suffix = period ? (/^(?:p|de la (?:tarde|noche))/.test(period) ? 'PM' : 'AM') : '';
    times.push(`${h}:${String(m).padStart(2, '0')}${suffix}`);
    return ' ';
  });
  return { days: [...new Set(days)], times: [...new Set(times)], rest };
}

/** A new appointment cannot inherit the old appointment's approval. */
export function startsNewSchedule(text: string): boolean {
  return /\b(?:another|second|additional|new|different|otra|otro|segunda|segundo|nueva|nuevo)\s+(?:\w+\s+)?(?:appointment|meeting|visit|viewing|reservation|cita|reunion|visita|reserva)\b/.test(normalize(text));
}

export function rememberApprovedSchedule(
  previous: ApprovedSchedule,
  question: string,
  reply: string,
  semantic?: string,
): ApprovedSchedule {
  const q = normalize(question);
  const r = normalize(reply);
  // Non-answer buttons and rejected/conditional values are never approval.
  if (semantic && !['yes', 'accept', 'relay_value'].includes(semantic)) return previous;
  if (/\b(no|not|don't|doesn't|isn't|won't|cannot|can't|maybe|perhaps|if|unless|quizas|tal vez|depende)\b/.test(r)) return previous;
  const offered = slots(q);
  const supplied = slots(r);
  if (/\b(birth|birthday|age|old|edad|nacimiento|cumpleanos|owners|propietarios)\b/.test(q)) return previous;
  const bareTimeQuestion = offered.times.length === 1 &&
    !offered.rest.replace(/\b(how|what|about|at|around|a|las|que|tal)\b/g, '').replace(/[\s?¿.!]/g, '');
  if (!SCHEDULE_TOPIC.test(q) && !offered.days.length && !bareTimeQuestion) return previous;
  const affirmative = semantic === 'yes' || semantic === 'accept' || /^(yes|si|okay|ok|sure|claro|accept)[.!\s]*$/.test(r);
  // A yes to an availability boundary is not approval of that exact hour.
  if (affirmative && /\b(before|after|until|till|between|from|through|around|earlier|later|antes|despues|entre|hasta|desde|aproximadamente)\b/.test(q)) return previous;
  // Semantic micro-button text contains examples, not operator facts. Only
  // relay/free-text answers may contribute their literal supplied values.
  const chosen = affirmative ? offered : supplied;
  if (!affirmative && (!chosen.days.length && !chosen.times.length)) return previous;
  if (chosen.days.length > 1 || chosen.times.length > 1) return previous;
  // Calendar/relative dates need richer date resolution. Keep them on the
  // normal approval path rather than silently conflating separate weeks.
  if (UNSUPPORTED_DATE.test(affirmative ? q : r)) return previous;
  const next = startsNewSchedule(q) ? {} as ApprovedSchedule : { ...previous };
  if (chosen.days.length === 1) {
    if (next.day !== chosen.days[0]) delete next.time;
    next.day = chosen.days[0];
  }
  if (chosen.times.length === 1) next.time = chosen.times[0];
  return next;
}

/**
 * Narrow synchronous exception to the commitment gate. Only simple read-backs
 * of delivered operator facts qualify. Unknown words/values stay fail-closed;
 * the contextual observer must not grant new permission on its own.
 */
export function isApprovedScheduleRecall(text: string, approved: ApprovedSchedule): boolean {
  if (!approved.day && !approved.time) return false;
  const normalized = normalize(text);
  if (CHANGE.test(normalized) || UNSUPPORTED_DATE.test(normalized)) return false;
  const parsed = slots(normalized);
  if (parsed.days.some((day) => day !== approved.day)) return false;
  if (parsed.times.some((time) => time !== approved.time &&
    // A bare hour can refer back to its explicitly approved AM/PM value,
    // but an explicit, different AM/PM or minute is never equivalent.
    (/[AP]M$/.test(time) || time !== approved.time?.replace(/[AP]M$/, '')))) return false;

  const asksTime = /\b(time|hora)\b/.test(normalized);
  const asksDay = /\b(day|date|dia|fecha)\b/.test(normalized);
  const asksWhole = /\b(when|plan|arrangement|details|confirm|confirmation|cuando|plan|detalles|confirmar|confirmemos|confirmamos)\b/.test(normalized);
  if (asksTime && !approved.time || asksDay && !approved.day) return false;
  if (asksWhole && !asksTime && !asksDay && !parsed.days.length && !parsed.times.length &&
    (!approved.day || !approved.time)) return false;
  if (!asksTime && !asksDay && !asksWhole && !parsed.days.length && !parsed.times.length) return false;

  // Deliberately omit money, locations, time zones, additional participants,
  // recurrence, cancellation and any other new terms. Mixed questions block.
  const remainder = parsed.rest.replace(/\b(?:what's|what|which|when|time|day|date|plan|arrangement|details|are|is|was|were|do|did|does|can|could|would|will|we|you|i|us|our|the|that|it|this|a|an|on|at|for|to|and|of|about|so|okay|ok|yeah|yes|well|then|just|please|again|already|still|let's|let|me|my|confirm|confirmation|confirming|agreed|agree|agreed on|set|said|say|decided|going|coming|come|meet|meeting|viewing|visit|appointment|scheduled|right|correct|works|work|with|que|cual|cuando|hora|dia|fecha|plan|detalles|es|era|son|a|las|el|la|los|de|del|en|y|para|por|nos|hemos|vamos|quedamos|quedado|acordamos|acordado|dijimos|confirmar|confirmemos|confirmamos|confirmando|reunion|cita|visita|ver|venir|entonces|bueno|vale|si|ya|solo|favor|otra vez|verdad|correcto)\b/g, ' ')
    .replace(/\b(vemos|reunirnos)\b/g, ' ').replace(/[\s.,?!¿¡'";:—-]/g, '');
  return !remainder;
}
