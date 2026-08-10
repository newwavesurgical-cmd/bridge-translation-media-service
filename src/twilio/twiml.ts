import Twilio from 'twilio';
import type { AppConfig } from '../config.js';
import { makeStreamToken } from '../auth.js';

const { twiml } = Twilio;

interface BuildTwiMlOptions {
  config: AppConfig;
  callId: string;
  userLanguage: string;
  remoteLanguage: string;
  announceTranslationAtStart: boolean;
  introMessageText?: string;
  introDisclaimerText?: string;
}

export function buildTranslatedCallTwiMl(options: BuildTwiMlOptions): string {
  if (!options.config.TRANSLATION_MEDIA_PUBLIC_WSS_URL || !options.config.BRIDGE_MEDIA_SHARED_SECRET) {
    throw new Error('TRANSLATION_MEDIA_PUBLIC_WSS_URL and BRIDGE_MEDIA_SHARED_SECRET are required');
  }

  const response = new twiml.VoiceResponse();
  if (options.announceTranslationAtStart) {
    const language = twilioSayLanguage(options.remoteLanguage) as 'es-ES';
    const introBlocks = introTextBlocks(options);
    for (const block of introBlocks) {
      response.say({ language }, block);
    }
  }

  const connect = response.connect();
  const stream = connect.stream({
    url: options.config.TRANSLATION_MEDIA_PUBLIC_WSS_URL
  });
  stream.parameter({ name: 'callId', value: options.callId });
  stream.parameter({ name: 'streamToken', value: makeStreamToken(options.config.BRIDGE_MEDIA_SHARED_SECRET, options.callId) });
  stream.parameter({ name: 'userLanguage', value: options.userLanguage });
  stream.parameter({ name: 'remoteLanguage', value: options.remoteLanguage });

  return response.toString();
}

function twilioSayLanguage(language: string): string {
  const normalized = language.toLowerCase();
  const map: Record<string, string> = {
    spanish: 'es-ES',
    es: 'es-ES',
    english: 'en-US',
    en: 'en-US',
    french: 'fr-FR',
    fr: 'fr-FR',
    german: 'de-DE',
    de: 'de-DE',
    italian: 'it-IT',
    it: 'it-IT',
    portuguese: 'pt-BR',
    pt: 'pt-BR',
    chinese: 'zh-CN',
    zh: 'zh-CN',
    japanese: 'ja-JP',
    ja: 'ja-JP',
    korean: 'ko-KR',
    ko: 'ko-KR'
  };
  return map[normalized] ?? 'en-US';
}

function introTextBlocks(options: BuildTwiMlOptions): string[] {
  const blocks = [options.introMessageText, options.introDisclaimerText].map(normalizeIntroText).filter((text): text is string => Boolean(text));
  return blocks.length > 0 ? blocks : [translationIntroText(options.remoteLanguage)];
}

function normalizeIntroText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 800) : undefined;
}

function translationIntroText(language: string): string {
  const normalized = language.toLowerCase();
  const map: Record<string, string> = {
    spanish: 'Hola. Esta llamada usa traduccion en vivo. Por favor, hable normalmente.',
    es: 'Hola. Esta llamada usa traduccion en vivo. Por favor, hable normalmente.',
    french: 'Bonjour. Cet appel utilise la traduction en direct. Veuillez parler normalement.',
    fr: 'Bonjour. Cet appel utilise la traduction en direct. Veuillez parler normalement.',
    german: 'Hallo. Dieser Anruf verwendet Live-Uebersetzung. Bitte sprechen Sie normal.',
    de: 'Hallo. Dieser Anruf verwendet Live-Uebersetzung. Bitte sprechen Sie normal.',
    italian: 'Ciao. Questa chiamata usa la traduzione in tempo reale. Per favore, parli normalmente.',
    it: 'Ciao. Questa chiamata usa la traduzione in tempo reale. Per favore, parli normalmente.',
    portuguese: 'Ola. Esta chamada usa traducao ao vivo. Por favor, fale normalmente.',
    pt: 'Ola. Esta chamada usa traducao ao vivo. Por favor, fale normalmente.',
    english: 'Hello. This call is using live translation. Please speak normally.',
    en: 'Hello. This call is using live translation. Please speak normally.'
  };
  return map[normalized] ?? 'Hello. This call is using live translation. Please speak normally.';
}
