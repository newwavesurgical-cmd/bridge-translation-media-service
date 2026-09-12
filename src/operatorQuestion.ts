export type OperatorQuestionKind = 'question' | 'choice' | 'commitment';

export interface OperatorQuestionClassification {
  text: string;
  kind: OperatorQuestionKind;
  blocking: boolean;
  reason: string;
}

const LEADING_FILLERS =
  /^(?:(?:um+|uh+|erm+|hmm+|mhm+|oh|okay|ok|well|so|hey|right|all right|alright|please|por favor|bueno|pues|a ver|mire|oiga|entonces|este)\b[\s,.:;!—-]*)+/i;

const ENGLISH_QUESTION_START =
  /^(?:what|what's|which|who|who's|whom|whose|when|where|where's|why|how|how's|is|isn't|are|aren't|am|was|were|do|don't|does|doesn't|did|didn't|can|can't|could|couldn't|would|will|won't|may|might|shall|should|have|haven't|has|hasn't|had)\b/i;

const SPANISH_QUESTION_START =
  /^[¿\s]*(?:qué|que|cómo|como|cuál|cual|cuáles|cuando|cuándo|cuánto|cuanto|dónde|donde|de dónde|quién|quien|por qué|para qué|es|está|esta|están|tiene|tienen|puede|podría|podria|hay|me puede|me podría|le puedo|se encuentra|sería|seria|desea|quiere)\b/i;

const SCHEDULING =
  /\b(?:appointment|schedule|scheduling|book|booking|reservation|meet|meeting|visit|showing|test drive|available|availability|days?|dates?|times?|today|tomorrow|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|a\.?m\.?|p\.?m\.?|cita|agenda|agendar|programar|reservar|reunión|reunion|visita|disponible|disponibilidad|días?|dias?|fechas?|horas?|hoy|mañana|manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i;

const SCHEDULING_CONTEXT =
  /\b(?:appointment|schedule|scheduling|book|booking|reservation|meet|meeting|visit|showing|test drive|come (?:see|by|in)|stop by|pick ?up|cita|agenda|agendar|programar|reservar|reunión|reunion|visita|venir|pasar|recoger)\b/i;

const CONCRETE_SCHEDULING_SLOT =
  /(?:\b(?:today|tomorrow|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoy|mañana|manana|esta noche|por la mañana|por la manana|por la tarde|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b|\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?::\s*\d{2})?\s*(?:a\s*\.?\s*m|p\s*\.?\s*m)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b)/i;

const COMMITMENT =
  /\b(?:accept|agree|approve|authorize|authorization|consent|confirm|commit|cancel|reschedule|purchase|order|reserve|price|cost|fee|rate|payment|are you sure|works? for you|okay with you|acept|acepta|aprobar|autorizar|autorización|autorizacion|consentimiento|confirmar|confirma|segur[oa]|comprometer|cancelar|reprogramar|comprar|pedido|reservar|precio|costo|tarifa|pago|le sirve|está bien|esta bien)\b/i;

const CALLER_FACT =
  /\b(?:name|age|old is|date of birth|birthday|phone|number|account|policy|member id|address|zip|postal|symptom|medication|doctor|provider|email|nombre|edad|años|anos|fecha de nacimiento|cumpleaños|cumpleanos|teléfono|telefono|número|numero|cuenta|póliza|poliza|dirección|direccion|código postal|codigo postal|síntoma|sintoma|medicamento|médico|medico|correo)\b/i;

const CHOICE =
  /\b(?:either|choose|choice|option|options|one of|or|which one|cual prefiere|cuál prefiere|opción|opcion|opciones|o bien)\b/i;

const NON_ACTIONABLE =
  /^(?:hello|hi|hola|buenas|thank you|thanks|gracias|yes|no|sí|si|sure|claro|perfect|great|goodbye|bye|adiós|adios)[.!\s]*$/i;

function normalize(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

export function stripQuestionFillers(text: string): string {
  return normalize(text).replace(LEADING_FILLERS, '').trim();
}

function looksQuestionLike(text: string): boolean {
  return (
    /[?？]/.test(text) ||
    text.startsWith('¿') ||
    ENGLISH_QUESTION_START.test(text) ||
    SPANISH_QUESTION_START.test(text)
  );
}

function looksLikeSchedulingProposal(text: string): boolean {
  if (!SCHEDULING.test(text)) return false;
  return (
    CHOICE.test(text) ||
    /\b(?:can we|could we|would (?:be|work|do|fit|suit)|does .* work|works? for|is (?:great|good|fine|okay|ok)|sounds? (?:great|good|fine|okay|ok)|let'?s do|how about|what about|we have|i have|we can do|i can do|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|podemos|estaría bien|estaria bien|sería bueno|seria bueno|le queda|le sirve|qué tal|que tal|tenemos)\b/i.test(
      text,
    )
  );
}

/**
 * Classify one complete (or sufficiently complete) callee utterance.
 *
 * This deliberately errs on the safe side for commitments: dates, times,
 * prices, consent, cancellations, and choices require a private operator
 * answer. Ordinary questions remain visible to diagnostics but do not stop a
 * mission-grounded reply.
 */
export function classifyOperatorQuestion(
  rawText: string,
  missionContext = '',
): OperatorQuestionClassification | null {
  const text = normalize(rawText);
  const core = stripQuestionFillers(text);
  if (!core || NON_ACTIONABLE.test(core)) return null;

  const schedulingProposal = looksLikeSchedulingProposal(core);
  const schedulingContext = SCHEDULING_CONTEXT.test(missionContext);
  const concreteSchedulingSlot = CONCRETE_SCHEDULING_SLOT.test(core);
  const question = looksQuestionLike(core);
  const schedulingQuestion =
    question &&
    /\b(?:what|which)\s+(?:days?|dates?|times?)|\bwhen\b.*\b(?:come|schedule|book|meet|meeting|visit|available)|\b(?:can|could)\s+(?:you|we)\s+(?:come|do|schedule|book|meet|visit)|\b(?:are you|is .*?)\s+available|\b(?:qué|que|cuál|cual)\s+(?:día|dia|fecha|hora)|\bcuándo\b.*\b(?:venir|agendar|programar|reservar|reunir|visitar)|\b(?:puede|podemos)\b.*\b(?:venir|agendar|programar|reservar|reunir|visitar)|\b(?:está|esta)\b.*\bdisponible/i.test(
      core,
    );
  // Live transcripts frequently deliver a proposed slot as a statement or a
  // fragment ("Wednesday would be great", then "1 p.m."). Once the mission is
  // a scheduling mission, a concrete day/date/time is itself a decision that
  // requires operator approval even without question punctuation.
  const schedulingDecision = concreteSchedulingSlot && schedulingContext;
  const choice = CHOICE.test(core) && (question || schedulingProposal || COMMITMENT.test(core));
  const commitment = COMMITMENT.test(core) || schedulingProposal || schedulingQuestion || schedulingDecision;
  const callerFactQuestion = CALLER_FACT.test(core) && question;
  const missingCallerFact = callerFactQuestion && !missionContainsCallerFact(core, missionContext);

  if (!question && !schedulingProposal && !schedulingDecision && !choice) return null;

  if (choice) {
    return {
      text,
      kind: 'choice',
      blocking: true,
      reason: 'The callee offered or requested a choice that requires operator approval.',
    };
  }
  if (commitment) {
    return {
      text,
      kind: 'commitment',
      blocking: true,
      reason: 'The callee requested a date, time, price, consent, or other commitment.',
    };
  }
  if (missingCallerFact) {
    return {
      text,
      kind: 'question',
      blocking: true,
      reason: 'The callee requested caller-side information that must come from the mission or operator.',
    };
  }
  return {
    text,
    kind: 'question',
    blocking: false,
    reason: callerFactQuestion
      ? 'The callee asked for a caller-side fact already present in prepared call memory.'
      : 'The callee asked a question; the prepared mission may already contain the answer.',
  };
}

function missionContainsCallerFact(question: string, missionContext: string): boolean {
  const mission = normalize(missionContext);
  if (!mission) return false;
  if (/\b(?:age|old is|edad|años|anos)\b/i.test(question)) {
    return (
      /\b\d{1,3}\s*(?:years? old|year-old|años|anos)\b/i.test(mission) ||
      /\b(?:age|edad)\s*[:=-]?\s*(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)\b/i.test(
        mission,
      )
    );
  }
  if (/\b(?:phone|telephone|teléfono|telefono)\b/i.test(question)) {
    return /(?:\+?\d[\d\s().-]{6,}\d)/.test(mission);
  }
  if (/\b(?:account|policy|member id|cuenta|póliza|poliza)\b/i.test(question)) {
    return /\b(?:account|policy|member id|cuenta|póliza|poliza)\b\s*(?:number|número|numero|id)?\s*[:#=-]?\s*[a-z0-9-]{3,}/i.test(
      mission,
    );
  }
  if (/\b(?:address|zip|postal|dirección|direccion|código postal|codigo postal)\b/i.test(question)) {
    return /\b\d{2,6}\s+[\p{L}\d][\p{L}\d .'-]{2,}\b/u.test(mission) || /\b\d{5}(?:-\d{4})?\b/.test(mission);
  }
  if (/\b(?:symptom|medication|síntoma|sintoma|medicamento)\b/i.test(question)) {
    return /\b(?:symptom|medication|fever|pain|cough|nausea|rash|síntoma|sintoma|medicamento|fiebre|dolor|tos|náusea|nausea)\b/i.test(
      mission,
    );
  }
  if (/\b(?:doctor|provider|médico|medico)\b/i.test(question)) {
    return /\b(?:doctor|dr\.?|provider|médico|medico)\s+[\p{L}][\p{L}.'-]+/iu.test(mission);
  }
  if (/\b(?:name|nombre)\b/i.test(question)) {
    return /\b(?:caller|patient|child|son|daughter|name|nombre)\s*(?:name)?\s*[:=-]\s*[\p{L}][\p{L}.'-]+/iu.test(
      mission,
    );
  }
  return false;
}
