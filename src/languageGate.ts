export type LanguageGateMode = 'off' | 'monitor' | 'soft_suppress' | 'strict_suppress';
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
  passFresh: boolean;
  passAgeMs: number | null;
  suppressionCount: number;
  uncertainCount: number;
  passCount: number;
  lastSuppressedText: string | null;
  lastText: string | null;
  recentEvents: LanguageGateEvent[];
}

type LanguageCode = 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'ja' | 'ko' | 'zh' | 'ar' | 'hi' | 'tr';

const MIN_TEXT_LENGTH = 12;
const MAX_EVENTS = 16;
const MAX_ROLLING_TEXT_LENGTH = 140;
const RECENT_TURN_TEXT_LENGTH = 90;
const ROLLING_TEXT_STALE_MS = 1200;
const OUTPUT_PASS_FRESH_MS = 12000;

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
  'aqui',
  'aquí',
  'ayuda',
  'ayudar',
  'bien',
  'claro',
  'como',
  'con',
  'cuando',
  'cuanto',
  'de',
  'del',
  'dices',
  'diciendo',
  'direccion',
  'duplicando',
  'donde',
  'el',
  'en',
  'endes',
  'esa',
  'ese',
  'eso',
  'enti',
  'entiendes',
  'escucha',
  'escuchar',
  'escucho',
  'esta',
  'estoy',
  'funciona',
  'funcionando',
  'gracias',
  'hablas',
  'historia',
  'hola',
  'impresionante',
  'informacion',
  'información',
  'la',
  'las',
  'le',
  'los',
  'me',
  'mesa',
  'momento',
  'molesta',
  'necesito',
  'para',
  'personas',
  'por',
  'porque',
  'pasa',
  'pasando',
  'puede',
  'puedes',
  'que',
  'qué',
  'quiero',
  'ridiculo',
  'ridículo',
  'reserva',
  'reservacion',
  'restaurante',
  'segundo',
  'si',
  'sí',
  'tambien',
  'tampoco',
  'tengo',
  'tu',
  'un',
  'una',
  'usted',
  'ya'
]);

const FRENCH_WORDS = new Set([
  'alors', 'avec', 'bonjour', 'ce', 'cela', 'cette', 'comme', 'dans', 'de', 'des', 'est', 'et', 'je', 'la', 'le',
  'les', 'mais', 'merci', 'mon', 'nous', 'oui', 'pas', 'pour', 'que', 'qui', 'suis', 'un', 'une', 'vous'
]);

const GERMAN_WORDS = new Set([
  'aber', 'auf', 'aus', 'bitte', 'das', 'danke', 'der', 'die', 'ein', 'eine', 'für', 'haben', 'hallo', 'ich', 'ist',
  'fur', 'ja', 'kann', 'mein', 'mit', 'nein', 'nicht', 'oder', 'sie', 'und', 'von', 'was', 'wie', 'wir', 'zu'
]);

const ITALIAN_WORDS = new Set([
  'anche', 'buongiorno', 'che', 'ciao', 'con', 'come', 'del', 'della', 'di', 'e', 'grazie', 'ho', 'il', 'io', 'la',
  'le', 'ma', 'mi', 'no', 'non', 'per', 'puo', 'sono', 'si', 'un', 'una', 'vorrei'
]);

const PORTUGUESE_WORDS = new Set([
  'a', 'agora', 'ajuda', 'bom', 'com', 'como', 'da', 'de', 'do', 'e', 'eu', 'favor', 'nao', 'obrigado', 'obrigada',
  'ola', 'os', 'para', 'por', 'preciso', 'que', 'sim', 'sou', 'um', 'uma', 'voce'
]);

const TURKISH_WORDS = new Set([
  'ama', 'ben', 'bir', 'bu', 'icin', 'ile', 'istiyorum', 'lütfen', 'lutfen', 'merhaba', 'mi', 'miyim', 'nasıl',
  'nasil', 'randevu', 'siz', 'teşekkürler', 'tesekkurler', 've', 'yardım', 'yardim', 'var', 'yok'
]);

const UNIVERSAL_WORDS = new Set(['ok', 'okay', 'no']);

const LATIN_LANGUAGE_WORDS: Record<'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'tr', Set<string>> = {
  en: ENGLISH_WORDS,
  es: SPANISH_WORDS,
  fr: FRENCH_WORDS,
  de: GERMAN_WORDS,
  it: ITALIAN_WORDS,
  pt: PORTUGUESE_WORDS,
  tr: TURKISH_WORDS
};

const EXPECTED_SHORT_UTTERANCES: Partial<Record<LanguageCode, RegExp>> = {
  en: /^(?:yes|hello|hi|thanks|thank you)$/iu,
  es: /^(?:sí|si|hola|gracias|claro)$/iu,
  fr: /^(?:oui|bonjour|merci|salut)$/iu,
  de: /^(?:ja|nein|hallo|danke|bitte)$/iu,
  it: /^(?:sì|si|ciao|grazie|buongiorno)$/iu,
  pt: /^(?:sim|olá|ola|obrigado|obrigada|bom dia)$/iu,
  ja: /^(?:はい|こんにちは|ありがとう)$/u,
  ko: /^(?:네|예|안녕하세요|감사합니다)$/u,
  zh: /^(?:是|好的|你好|谢谢|謝謝)$/u,
  ar: /^(?:نعم|مرحبا|شكرا)$/u,
  hi: /^(?:हाँ|नमस्ते|धन्यवाद)$/u,
  tr: /^(?:evet|hayır|hayir|merhaba|teşekkürler|tesekkurler)$/iu
};

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
  private lastPassAt = 0;
  private readonly recentEvents: LanguageGateEvent[] = [];

  constructor(
    private readonly expectedLanguage: string,
    private readonly mode: LanguageGateMode = 'monitor'
  ) {
    this.suppressed = mode === 'strict_suppress';
  }

  resetTurn(): void {
    this.detectedLanguage = null;
    this.confidence = 0;
    this.decision = 'uncertain';
    this.suppressed = this.mode === 'strict_suppress';
    this.rollingText = '';
    this.lastObservedAt = 0;
    this.lastPassAt = 0;
  }

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
    const shortCandidate = appendRollingText(this.rollingText, trimmed);
    const expectedShort =
      expected &&
      (matchesExpectedShortUtterance(trimmed, expected) ||
        matchesExpectedShortUtterance(shortCandidate, expected));
    const deltaDetection = expectedShort
      ? { language: expected, confidence: 0.98 }
      : classifyLanguage(trimmed);
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
    const fullDetection = classifyLanguage(this.rollingText);
    const recentText = tailText(this.rollingText, RECENT_TURN_TEXT_LENGTH);
    const recentDetection = classifyLanguage(recentText);
    const detection = expectedShort
      ? deltaDetection
      : recentDetection.language &&
          recentDetection.confidence >= 0.72 &&
          (!fullDetection.language || recentDetection.language !== fullDetection.language || recentDetection.language === expected)
        ? recentDetection
        : fullDetection;
    if (detection === recentDetection) {
      this.rollingText = recentText;
      this.lastText = this.rollingText;
    }
    this.detectedLanguage = detection.language;
    this.confidence = detection.confidence;

    if (!expected || !detection.language || detection.confidence < 0.72) {
      this.uncertainCount += 1;
      this.decision = 'uncertain';
      this.suppressed = this.mode === 'strict_suppress';
    } else if (detection.language === expected) {
      this.passCount += 1;
      this.decision = this.mode === 'monitor' ? 'monitor' : 'pass';
      this.suppressed = false;
      this.lastPassAt = now;
    } else if (this.mode === 'soft_suppress' || this.mode === 'strict_suppress') {
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
    return (this.mode === 'soft_suppress' || this.mode === 'strict_suppress') && this.suppressed;
  }

  shouldPassOutput(): boolean {
    if (this.mode === 'off') {
      return true;
    }
    if (this.shouldSuppressOutput()) {
      return false;
    }
    if (this.decision === 'uncertain') {
      return this.isPassFresh();
    }
    if (this.decision !== 'pass' && this.decision !== 'monitor') {
      return false;
    }
    return this.isPassFresh();
  }

  diagnostics(): LanguageGateDiagnostics {
    const now = Date.now();
    return {
      mode: this.mode,
      expectedLanguage: this.expectedLanguage,
      detectedLanguage: this.detectedLanguage,
      confidence: Number(this.confidence.toFixed(2)),
      decision: this.decision,
      suppressed: this.shouldSuppressOutput(),
      passFresh: this.isPassFresh(now),
      passAgeMs: this.lastPassAt ? now - this.lastPassAt : null,
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

  private isPassFresh(now = Date.now()): boolean {
    return Boolean(this.lastPassAt) && now - this.lastPassAt <= OUTPUT_PASS_FRESH_MS;
  }
}

export function classifyLanguage(text: string): { language: LanguageCode | null; confidence: number } {
  const scripted = classifyScriptLanguage(text);
  if (scripted) {
    return { language: scripted, confidence: 0.98 };
  }
  const normalized = normalizeText(text);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const meaningfulTokens = tokens.filter((token) => !UNIVERSAL_WORDS.has(token));

  if (normalized.length < MIN_TEXT_LENGTH || meaningfulTokens.length < 2) {
    return { language: null, confidence: 0 };
  }

  const scores: Record<'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'tr', number> = {
    en: 0,
    es: 0,
    fr: 0,
    de: 0,
    it: 0,
    pt: 0,
    tr: 0
  };
  for (const token of meaningfulTokens) {
    for (const [language, words] of Object.entries(LATIN_LANGUAGE_WORDS) as Array<
      ['en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'tr', Set<string>]
    >) {
      if (words.has(token)) scores[language] += 1;
    }
  }

  if (/[¿¡áéíóúüñ]/i.test(text)) {
    scores.es += 2;
  }
  if (
    /\b(?:enti\s*endes|entiendes|diciendo|dices|funciona|funcionando|est[aá]\s*funcionando|direcci[oó]n|molesta|hablas|tengo|tampoco|qu[eé]\s*t[uú]|por\s*qu[eé]|qu[eé]\s+pasa|qu[eé]\s+est[aá]\s+pasando|historia\s+muy\s+linda|muy\s+impresionante)\b/i.test(
      text
    )
  ) {
    scores.es += 3;
  }
  if (
    /\b(?:t[uú]|me|no|ya|eso|s[ií])\b[\s,]*(?:enti|endes|entiendes|funciona|molesta|tengo|direcci[oó]n)\b/i.test(
      text
    )
  ) {
    scores.es += 2;
  }
  if (/\b(i'm|i’ll|i'd|don't|can't|wouldn't|you're|we're)\b/i.test(text)) {
    scores.en += 2;
  }

  if (/[ãõç]/i.test(text)) scores.pt += 2;
  if (/[àâçéèêëîïôùûüÿœ]/i.test(text)) scores.fr += 2;
  if (/[äöüß]/i.test(text)) scores.de += 2;
  if (/[çğıöşü]/i.test(text)) scores.tr += 2;

  const ranked = (Object.entries(scores) as Array<[LanguageCode, number]>).sort(
    (a, b) => b[1] - a[1]
  );
  const [winner, runnerUp] = ranked;
  const winnerScore = winner?.[1] ?? 0;
  const runnerUpScore = runnerUp?.[1] ?? 0;
  const margin = winnerScore - runnerUpScore;
  if (!winner || winnerScore < 2 || margin < 1) {
    return { language: null, confidence: 0.35 };
  }

  const confidence = Math.min(0.98, 0.62 + margin / Math.max(5, winnerScore + runnerUpScore));
  return { language: winner[0], confidence };
}

export function supportedLanguageCode(language: string): LanguageCode | null {
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const primary = normalized.split('-')[0] ?? normalized;
  const map: Record<string, LanguageCode> = {
    english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', turkish: 'tr',
    japanese: 'ja', korean: 'ko', chinese: 'zh', mandarin: 'zh', arabic: 'ar', hindi: 'hi',
    en: 'en', es: 'es', fr: 'fr', de: 'de', it: 'it', pt: 'pt', ja: 'ja', ko: 'ko', zh: 'zh', ar: 'ar', hi: 'hi', tr: 'tr'
  };
  return map[normalized] ?? map[primary] ?? null;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesExpectedShortUtterance(text: string, expected: LanguageCode): boolean {
  const matcher = EXPECTED_SHORT_UTTERANCES[expected];
  const trimmed = text.trim();
  if (!matcher || !trimmed) return false;
  return matcher.test(trimmed) || matcher.test(trimmed.replace(/\s+/g, ''));
}

function classifyScriptLanguage(text: string): LanguageCode | null {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
  if (/[\u0600-\u06ff]/u.test(text)) return 'ar';
  if (/[\u0900-\u097f]/u.test(text)) return 'hi';
  return null;
}

function appendRollingText(current: string, delta: string): string {
  const combined = `${current}${needsSpace(current, delta) ? ' ' : ''}${delta}`.trim();
  if (combined.length <= MAX_ROLLING_TEXT_LENGTH) {
    return combined;
  }
  return tailText(combined, MAX_ROLLING_TEXT_LENGTH);
}

function tailText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text.trim();
  }
  return text.slice(text.length - maxLength).replace(/^\S+\s*/, '').trim();
}

function needsSpace(current: string, delta: string): boolean {
  if (!current || !delta) {
    return false;
  }
  return /[\p{L}\p{N}]$/u.test(current) && /^[\p{L}\p{N}]/u.test(delta);
}
