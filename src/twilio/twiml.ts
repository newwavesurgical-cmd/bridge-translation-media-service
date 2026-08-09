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
}

export function buildTranslatedCallTwiMl(options: BuildTwiMlOptions): string {
  if (!options.config.TRANSLATION_MEDIA_PUBLIC_WSS_URL || !options.config.BRIDGE_MEDIA_SHARED_SECRET) {
    throw new Error('TRANSLATION_MEDIA_PUBLIC_WSS_URL and BRIDGE_MEDIA_SHARED_SECRET are required');
  }

  const response = new twiml.VoiceResponse();
  if (options.announceTranslationAtStart) {
    response.say(
      { language: twilioSayLanguage(options.remoteLanguage) as 'es-ES' },
      'Hello. This call is using live translation. Please speak normally.'
    );
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
