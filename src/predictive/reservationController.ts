import type { PredictiveMode } from '../types/messages.js';

export type ReservationSlot =
  | 'party_size'
  | 'date'
  | 'time'
  | 'name'
  | 'phone_number'
  | 'confirmation'
  | 'seating_preference'
  | 'special_requests';

export interface PredictiveEvent {
  event:
    | 'turn_started'
    | 'prefix_audio_started'
    | 'slot_resolved'
    | 'completion_audio_started'
    | 'turn_timeout'
    | 'unsupported_language'
    | 'speech_error';
  mode: PredictiveMode;
  slot?: ReservationSlot;
  intent?: string;
  text?: string;
  detail?: string;
  at: string;
}

export interface PredictiveDiagnostics {
  predictiveMode: PredictiveMode;
  predictiveActiveTurn: boolean;
  predictiveRecognizedIntent: string | null;
  predictivePendingSlot: ReservationSlot | null;
  predictiveResolvedSlots: Partial<Record<ReservationSlot, string>>;
  predictiveSuppressedOwnerAudioChunks: number;
  predictivePrefixAudioChunks: number;
  predictiveCompletionAudioChunks: number;
  remoteQuestionUnderstoodAt: string | null;
  safePrefixFirstAudioAt: string | null;
  userSlotDetectedAt: string | null;
  completionFirstAudioAt: string | null;
}

interface PredictiveReservationControllerOptions {
  userLanguage: string;
  remoteLanguage: string;
  speakToRemote: (text: string, phase: 'prefix' | 'completion') => Promise<number>;
  emitEvent: (event: PredictiveEvent) => void;
}

interface ActiveTurn {
  slot: ReservationSlot;
  intent: string;
  prefix: string;
  startedAt: number;
  ownerBuffer: string;
  completionSpoken: boolean;
}

const TURN_TIMEOUT_MS = 12_000;
const MIN_OWNER_BUFFER_CHARS = 2;

export class PredictiveReservationController {
  private readonly options: PredictiveReservationControllerOptions;
  private readonly supported: boolean;
  private remoteTranslationBuffer = '';
  private activeTurn?: ActiveTurn;
  private resolvedSlots: Partial<Record<ReservationSlot, string>> = {};
  private suppressedOwnerAudioChunks = 0;
  private prefixAudioChunks = 0;
  private completionAudioChunks = 0;
  private recognizedIntent: string | null = null;
  private remoteQuestionUnderstoodAt: string | null = null;
  private safePrefixFirstAudioAt: string | null = null;
  private userSlotDetectedAt: string | null = null;
  private completionFirstAudioAt: string | null = null;

  constructor(options: PredictiveReservationControllerOptions) {
    this.options = options;
    this.supported = isEnglish(options.userLanguage) && isSpanish(options.remoteLanguage);
    if (!this.supported) {
      this.emit('unsupported_language', {
        detail: 'Predictive restaurant reservation mode currently supports English user language and Spanish remote language only.'
      });
    }
  }

  get mode(): PredictiveMode {
    return 'restaurant_reservation_v1';
  }

  get isSupported(): boolean {
    return this.supported;
  }

  handleRemoteTranslationDelta(delta: string): void {
    if (!this.supported) {
      return;
    }
    this.remoteTranslationBuffer = trimContext(this.remoteTranslationBuffer + delta, 1200);
    if (this.activeTurn && !this.turnExpired()) {
      return;
    }
    if (this.turnExpired()) {
      this.timeoutTurn();
    }

    const question = detectReservationQuestion(this.remoteTranslationBuffer);
    if (!question) {
      return;
    }

    this.startTurn(question.slot, question.intent, question.prefix);
  }

  handleOwnerSourceDelta(delta: string): void {
    if (!this.supported || !this.activeTurn || this.activeTurn.completionSpoken) {
      return;
    }
    if (this.turnExpired()) {
      this.timeoutTurn();
      return;
    }

    this.activeTurn.ownerBuffer = trimContext(this.activeTurn.ownerBuffer + delta, 500);
    if (this.activeTurn.ownerBuffer.trim().length < MIN_OWNER_BUFFER_CHARS) {
      return;
    }

    const resolved = resolveSlotValue(this.activeTurn.slot, this.activeTurn.ownerBuffer);
    if (!resolved) {
      return;
    }

    this.activeTurn.completionSpoken = true;
    this.resolvedSlots[this.activeTurn.slot] = resolved.value;
    this.userSlotDetectedAt = new Date().toISOString();
    this.emit('slot_resolved', {
      slot: this.activeTurn.slot,
      intent: this.activeTurn.intent,
      text: resolved.value
    });

    void this.speakCompletion(this.activeTurn.slot, resolved.spokenCompletion);
  }

  shouldSuppressOwnerTranslation(): boolean {
    if (!this.supported || !this.activeTurn) {
      return false;
    }
    if (this.turnExpired()) {
      this.timeoutTurn();
      return false;
    }
    return true;
  }

  recordSuppressedOwnerAudioChunk(): void {
    this.suppressedOwnerAudioChunks += 1;
  }

  diagnostics(): PredictiveDiagnostics {
    return {
      predictiveMode: this.mode,
      predictiveActiveTurn: Boolean(this.activeTurn && !this.turnExpired()),
      predictiveRecognizedIntent: this.recognizedIntent,
      predictivePendingSlot: this.activeTurn?.slot ?? null,
      predictiveResolvedSlots: { ...this.resolvedSlots },
      predictiveSuppressedOwnerAudioChunks: this.suppressedOwnerAudioChunks,
      predictivePrefixAudioChunks: this.prefixAudioChunks,
      predictiveCompletionAudioChunks: this.completionAudioChunks,
      remoteQuestionUnderstoodAt: this.remoteQuestionUnderstoodAt,
      safePrefixFirstAudioAt: this.safePrefixFirstAudioAt,
      userSlotDetectedAt: this.userSlotDetectedAt,
      completionFirstAudioAt: this.completionFirstAudioAt
    };
  }

  private startTurn(slot: ReservationSlot, intent: string, prefix: string): void {
    this.activeTurn = {
      slot,
      intent,
      prefix,
      startedAt: Date.now(),
      ownerBuffer: '',
      completionSpoken: false
    };
    this.recognizedIntent = intent;
    this.remoteQuestionUnderstoodAt = new Date().toISOString();
    this.remoteTranslationBuffer = '';
    this.emit('turn_started', { slot, intent, text: prefix });
    void this.speakPrefix(prefix, slot, intent);
  }

  private async speakPrefix(prefix: string, slot: ReservationSlot, intent: string): Promise<void> {
    try {
      const chunks = await this.options.speakToRemote(prefix, 'prefix');
      this.prefixAudioChunks += chunks;
      this.safePrefixFirstAudioAt ??= new Date().toISOString();
      this.emit('prefix_audio_started', { slot, intent, text: prefix });
    } catch (error) {
      this.emit('speech_error', { slot, intent, detail: errorMessage(error) });
    }
  }

  private async speakCompletion(slot: ReservationSlot, completion: string): Promise<void> {
    const turn = this.activeTurn;
    try {
      const chunks = await this.options.speakToRemote(completion, 'completion');
      this.completionAudioChunks += chunks;
      this.completionFirstAudioAt ??= new Date().toISOString();
      this.emit('completion_audio_started', { slot, intent: turn?.intent, text: completion });
    } catch (error) {
      this.emit('speech_error', { slot, intent: turn?.intent, detail: errorMessage(error) });
    } finally {
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
    }
  }

  private timeoutTurn(): void {
    if (!this.activeTurn) {
      return;
    }
    this.emit('turn_timeout', {
      slot: this.activeTurn.slot,
      intent: this.activeTurn.intent,
      detail: 'No user slot value was detected before the predictive turn timeout.'
    });
    this.activeTurn = undefined;
  }

  private turnExpired(): boolean {
    return Boolean(this.activeTurn && Date.now() - this.activeTurn.startedAt > TURN_TIMEOUT_MS);
  }

  private emit(event: PredictiveEvent['event'], partial: Omit<PredictiveEvent, 'event' | 'mode' | 'at'> = {}): void {
    this.options.emitEvent({ event, mode: this.mode, at: new Date().toISOString(), ...partial });
  }
}

interface DetectedQuestion {
  slot: ReservationSlot;
  intent: string;
  prefix: string;
}

export function detectReservationQuestion(text: string): DetectedQuestion | null {
  const normalized = normalize(text);
  if (!looksLikeQuestion(normalized)) {
    return null;
  }
  if (/\b(how many|number of)\b.*\b(people|persons|guests|party)\b/.test(normalized)) {
    return { slot: 'party_size', intent: 'reservation_party_size', prefix: 'Claro, puedo hacer la reservación para...' };
  }
  if (/\b(what time|which time|at what time|what hour|when)\b/.test(normalized) && /\b(come|arrive|reservation|book|table)\b/.test(normalized)) {
    return { slot: 'time', intent: 'reservation_time', prefix: 'Perfecto, la puedo anotar para...' };
  }
  if (/\b(what day|which day|what date|which date|when)\b/.test(normalized) && /\b(reservation|book|table|come)\b/.test(normalized)) {
    return { slot: 'date', intent: 'reservation_date', prefix: 'Por supuesto, la reservación sería para...' };
  }
  if (/\b(name|under what name|your name)\b/.test(normalized)) {
    return { slot: 'name', intent: 'reservation_name', prefix: 'Claro, el nombre es...' };
  }
  if (/\b(phone|telephone|number|contact)\b/.test(normalized)) {
    return { slot: 'phone_number', intent: 'reservation_phone_number', prefix: 'Sí, el número es...' };
  }
  if (/\b(confirm|correct|is that right|okay|ok|is this fine)\b/.test(normalized)) {
    return { slot: 'confirmation', intent: 'reservation_confirmation', prefix: 'Sí...' };
  }
  if (/\b(inside|outside|outdoor|patio|booth|table|seating|seat)\b/.test(normalized)) {
    return { slot: 'seating_preference', intent: 'reservation_seating', prefix: 'De acuerdo, preferimos...' };
  }
  if (/\b(special request|anything else|allerg|occasion|note|notes)\b/.test(normalized)) {
    return { slot: 'special_requests', intent: 'reservation_special_requests', prefix: 'Sí, también queremos mencionar que...' };
  }
  return null;
}

export function resolveSlotValue(slot: ReservationSlot, text: string): { value: string; spokenCompletion: string } | null {
  const normalized = normalize(text);
  if (/\b(actually|correction|change|make that)\b/.test(normalized)) {
    // The resolvers below intentionally use the last matching value, which handles short corrections.
  }

  switch (slot) {
    case 'party_size': {
      const value = lastNumberValue(normalized);
      return value ? { value: String(value), spokenCompletion: `${value} personas.` } : null;
    }
    case 'time': {
      const value = lastTimeValue(normalized);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'date': {
      const value = dateValue(normalized);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'name': {
      const value = nameValue(text);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'phone_number': {
      const value = phoneValue(normalized);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'confirmation': {
      const value = confirmationValue(normalized);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'seating_preference': {
      const value = seatingValue(normalized);
      return value ? { value, spokenCompletion: `${value}.` } : null;
    }
    case 'special_requests': {
      const value = specialRequestValue(text);
      return value ? { value, spokenCompletion: value } : null;
    }
    default:
      return null;
  }
}

function isEnglish(language: string): boolean {
  return ['english', 'en', 'en-us', 'en-gb'].includes(language.trim().toLowerCase());
}

function isSpanish(language: string): boolean {
  return ['spanish', 'es', 'es-es', 'es-mx'].includes(language.trim().toLowerCase());
}

function looksLikeQuestion(text: string): boolean {
  return /[?]|\b(how many|what|which|when|can you|would you|do you|is that|name|phone|number|inside|outside|special)\b/.test(text);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
}

function trimContext(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function lastNumberValue(text: string): number | null {
  const values: number[] = [];
  for (const match of text.matchAll(/\b\d{1,2}\b/g)) {
    values.push(Number(match[0]));
  }
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20
  };
  for (const match of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g)) {
    values.push(words[match[1]] ?? 0);
  }
  const valid = values.filter((value) => value > 0);
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

function lastTimeValue(text: string): string | null {
  const numericMatches = [...text.matchAll(/\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)?\b/g)];
  if (numericMatches.length > 0) {
    const match = numericMatches[numericMatches.length - 1];
    const hour = match[1];
    const minutes = match[2] ? `:${match[2]}` : '';
    const meridiem = match[3] ? ` ${match[3].replace(/\./g, '')}` : '';
    return `${hour}${minutes}${meridiem}`.trim();
  }
  const number = lastNumberValue(text);
  if (number && number <= 12) {
    return `${number}`;
  }
  return null;
}

function dateValue(text: string): string | null {
  const dayMap: Record<string, string> = {
    today: 'hoy',
    tonight: 'esta noche',
    tomorrow: 'mañana',
    monday: 'lunes',
    tuesday: 'martes',
    wednesday: 'miércoles',
    thursday: 'jueves',
    friday: 'viernes',
    saturday: 'sábado',
    sunday: 'domingo'
  };
  for (const [english, spanish] of Object.entries(dayMap)) {
    if (new RegExp(`\\b${english}\\b`).test(text)) {
      return spanish;
    }
  }
  const date = text.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
  return date?.[0] ?? null;
}

function nameValue(text: string): string | null {
  const match = text.match(/\b(?:my name is|name is|under|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/);
  if (match?.[1]) {
    return match[1].trim();
  }
  const trimmed = text.replace(/[.?!]/g, ' ').trim();
  return /^[A-Z][A-Za-z' -]{1,60}$/.test(trimmed) ? trimmed : null;
}

function phoneValue(text: string): string | null {
  const digits = [...text.matchAll(/\d/g)].map((match) => match[0]).join('');
  if (digits.length >= 7) {
    return digits.split('').join(' ');
  }
  return null;
}

function confirmationValue(text: string): string | null {
  if (/\b(yes|yeah|yep|correct|that's right|that is right|ok|okay|sure)\b/.test(text)) {
    return 'sí, está correcto';
  }
  if (/\b(no|nope|not correct|wrong)\b/.test(text)) {
    return 'no, necesito corregirlo';
  }
  return null;
}

function seatingValue(text: string): string | null {
  if (/\b(outside|outdoor|patio)\b/.test(text)) {
    return 'una mesa afuera';
  }
  if (/\b(inside|indoor)\b/.test(text)) {
    return 'una mesa adentro';
  }
  if (/\b(booth)\b/.test(text)) {
    return 'una cabina';
  }
  if (/\b(table)\b/.test(text)) {
    return 'una mesa';
  }
  return null;
}

function specialRequestValue(text: string): string | null {
  const normalized = normalize(text);
  if (/\b(no|none|nothing|no special)\b/.test(normalized)) {
    return 'no tenemos ninguna petición especial.';
  }
  if (/\b(allerg|birthday|anniversary|wheelchair|high chair|quiet)\b/.test(normalized)) {
    return `tenemos una petición especial: ${text.trim().replace(/[.?!]*$/, '')}.`;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown predictive speech error';
}
