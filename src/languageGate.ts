export type LanguageGateMode = 'off' | 'monitor' | 'soft_suppress';
export type LanguageGateDecision = 'pass' | 'monitor' | 'suppress' | 'uncertain';

export interface LanguageGateEvent {
  at: string;
  expectedLanguage: string;
  detectedLanguage: string | null;
  confidence: number;
  decision: LanguageGateDecision;
  text: string;
}

export interface LanguageGateDiagnostics {
  mode: LanguageGateMode;
  expectedLanguage: string;
  detectedLanguage: string | null;
  confidence: number;
  decision: LanguageGateDecision;
  suppressed: boolean;
  suppressionCount: number;
  uncertainCount: number;
  passCount: number;
  lastSuppressedText: string | null;
  lastText: string | null;
  recentEvents: LanguageGateEvent[];
}

type LanguageCode = 'en' | 'es';

const MIN_TEXT_LENGTH = 12;
const MAX_EVENTS = 16;
const MAX_ROLLING_TEXT_LENGTH = 260;
const ROLLING_TEXT_STALE_MS = 2500;

const ENGLISH_WORDS = new Set([
  'a',
  'about',
  'and',
  'are',
  'available',
  'be',
  'can',
  'could',
  'do',
  'for',
  'from',
  'have',
  'hear',
  'hello',
  'help',
  'hi',
  'how',
  'i',
  'is',
  'it',
  'like',
  'make',
  'me',
  'my',
  'need',
  'people',
  'please',
  'reservation',
  'reserve',
  'restaurant',
  'table',
  'thank',
  'that',
  'the',
  'there',
  'this',
  'time',
  'to',
  'want',
  'we',
  'what',
  'when',
  'where',
  'would',
  'you'
]);

const SPANISH_WORDS = new Set([
  'a',
  'ahora',
  'ayuda',
  'ayudar',
  'claro',
  'como',
  'con',
  'cuando',
  'cuanto',
  'de',
  'del',
  'duplicando',
  'donde',
  'el',
  'en',
  'escucha',
  'escuchar',
  'escucho',
  'esta',
  'estoy',
  'gracias',
  'hola',
  'informacion',
  'información',
  'la',
  'las',
  'le',
  'los',
  'me',
  'mesa',
  'momento',
  'necesito',
  'para',
  'personas',
  'por',
  'porque',
  'puede',
  'puedes',
  'que',
  'quiero',
  'ridiculo',
  'ridículo',
  'reserva',
  'reservacion',
  'restaurante',
  'segundo',
  'si',
  'sí',
  'un',
  'una',
  'usted'
]);

const UNIVERSAL_WORDS = new Set(['ok', 'okay', 'no', 'yes', 'si', 'sí', 'hello', 'hola', 'gracias', 'thanks']);

export class TranscriptLanguageGate {
  private detectedLanguage: string | null = null;
  private confidence = 0;
  private decision: LanguageGateDecision = 'uncertain';
  private suppressed = false;
  private suppressionCount = 0;
  private uncertainCount = 0;
  private passCount = 0;
  private lastSuppressedText: string | null = null;
  private lastText: string | null = null;
  private rollingText = '';
  private lastObservedAt = 0;
  private readonly recentEvents: LanguageGateEvent[] = [];

  constructor(
    private readonly expectedLanguage: string,
    private readonly mode: LanguageGateMode = 'monitor'
  ) {}

  observe(text: string): LanguageGateDecision {
    const trimmed = text.trim();
    if (!trimmed) {
      return this.decision;
    }

    const now = Date.now();
    if (this.lastObservedAt && now - this.lastObservedAt > ROLLING_TEXT_STALE_MS) {
      this.rollingText = '';
    }
    this.lastObservedAt = now;

    const expected = supportedLanguageCode(this.expectedLanguage);
    const deltaDetection = classifyLanguage(trimmed);
    const currentDetection = classifyLanguage(this.rollingText);
    const confidentDelta = deltaDetection.language && deltaDetection.confidence >= 0.72;
    const deltaLanguageChanged =
      confidentDelta && currentDetection.language && currentDetection.language !== deltaDetection.language;

    if ((expected && deltaDetection.language === expected && deltaDetection.confidence >= 0.72) || deltaLanguageChanged) {
      this.rollingText = trimmed;
    } else {
      this.rollingText = appendRollingText(this.rollingText, trimmed);
    }
    this.lastText = this.rollingText;
    const detection = classifyLanguage(this.rollingText);
    this.detectedLanguage = detection.language;
    this.confidence = detection.confidence;

    if (!expected || !detection.language || detection.confidence < 0.72) {
      this.uncertainCount += 1;
      this.decision = 'uncertain';
      this.suppressed = false;
    } else if (detection.language === expected) {
      this.passCount += 1;
      this.decision = this.mode === 'monitor' ? 'monitor' : 'pass';
      this.suppressed = false;
    } else if (this.mode === 'soft_suppress') {
      this.suppressionCount += 1;
      this.lastSuppressedText = this.rollingText;
      this.decision = 'suppress';
      this.suppressed = true;
    } else {
      this.decision = this.mode === 'off' ? 'pass' : 'monitor';
      this.suppressed = false;
    }

    this.recordEvent(this.rollingText);
    return this.decision;
  }

  shouldSuppressOutput(): boolean {
    return this.mode === 'soft_suppress' && this.suppressed;
  }

  shouldPassOutput(): boolean {
    if (this.mode === 'off') {
      return true;
    }
    return this.decision === 'pass' || this.decision === 'monitor';
  }

  diagnostics(): LanguageGateDiagnostics {
    return {
      mode: this.mode,
      expectedLanguage: this.expectedLanguage,
      detectedLanguage: this.detectedLanguage,
      confidence: Number(this.confidence.toFixed(2)),
      decision: this.decision,
      suppressed: this.shouldSuppressOutput(),
      suppressionCount: this.suppressionCount,
      uncertainCount: this.uncertainCount,
      passCount: this.passCount,
      lastSuppressedText: this.lastSuppressedText,
      lastText: this.lastText,
      recentEvents: [...this.recentEvents]
    };
  }

  private recordEvent(text: string): void {
    this.recentEvents.push({
      at: new Date().toISOString(),
      expectedLanguage: this.expectedLanguage,
      detectedLanguage: this.detectedLanguage,
      confidence: Number(this.confidence.toFixed(2)),
      decision: this.decision,
      text
    });
    if (this.recentEvents.length > MAX_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_EVENTS);
    }
  }
}

export function classifyLanguage(text: string): { language: LanguageCode | null; confidence: number } {
  const normalized = normalizeText(text);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const meaningfulTokens = tokens.filter((token) => !UNIVERSAL_WORDS.has(token));

  if (normalized.length < MIN_TEXT_LENGTH || meaningfulTokens.length < 2) {
    return { language: null, confidence: 0 };
  }

  let englishScore = 0;
  let spanishScore = 0;

  for (const token of meaningfulTokens) {
    if (ENGLISH_WORDS.has(token)) {
      englishScore += 1;
    }
    if (SPANISH_WORDS.has(token)) {
      spanishScore += 1;
    }
  }

  if (/[¿¡áéíóúüñ]/i.test(text)) {
    spanishScore += 2;
  }
  if (/\b(i'm|i’ll|i'd|don't|can't|wouldn't|you're|we're)\b/i.test(text)) {
    englishScore += 2;
  }

  const total = englishScore + spanishScore;
  const margin = Math.abs(englishScore - spanishScore);
  if (total < 2 || margin < 2) {
    return { language: null, confidence: 0.35 };
  }

  const language: LanguageCode = englishScore > spanishScore ? 'en' : 'es';
  const confidence = Math.min(0.98, 0.55 + margin / Math.max(4, total));
  return { language, confidence };
}

export function supportedLanguageCode(language: string): LanguageCode | null {
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const primary = normalized.split('-')[0] ?? normalized;
  if (normalized === 'english' || primary === 'en') {
    return 'en';
  }
  if (normalized === 'spanish' || normalized === 'es' || primary === 'es') {
    return 'es';
  }
  return null;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-zñáéíóúü\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendRollingText(current: string, delta: string): string {
  const combined = `${current}${needsSpace(current, delta) ? ' ' : ''}${delta}`.trim();
  if (combined.length <= MAX_ROLLING_TEXT_LENGTH) {
    return combined;
  }
  return combined.slice(combined.length - MAX_ROLLING_TEXT_LENGTH).replace(/^\S+\s*/, '').trim();
}

function needsSpace(current: string, delta: string): boolean {
  if (!current || !delta) {
    return false;
  }
  return /\w$/.test(current) && /^\w/.test(delta);
}
