import { describe, expect, it } from 'vitest';
import { buildTranslatedCallTwiMl } from '../src/twilio/twiml.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  PORT: 8787,
  PUBLIC_BASE_URL: 'https://bridge-media.example.com',
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/twilio/stream',
  APP_STREAM_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/app/stream',
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_TRANSLATION_MODEL: 'gpt-realtime-translate',
  OPENAI_TTS_MODEL: 'gpt-4o-mini-tts',
  OPENAI_TTS_VOICE: 'cedar',
  OPENAI_FILLER_TTS_VOICE: 'onyx',
  OPENAI_SAFETY_IDENTIFIER: 'test-user',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'auth',
  TWILIO_PHONE_NUMBER: '+15551234567',
  BRIDGE_MEDIA_SHARED_SECRET: 'test-secret-long-enough',
  BRIDGE_MEDIA_API_KEY: 'test-service-api-key-long-enough',
  DRY_RUN_CALLS: true
};

describe('translated call TwiML', () => {
  it('connects Twilio to the media websocket with custom parameters', () => {
    const xml = buildTranslatedCallTwiMl({
      config,
      callId: 'call_test',
      userLanguage: 'English',
      remoteLanguage: 'Spanish',
      announceTranslationAtStart: true
    });

    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream url="wss://bridge-media.example.com/twilio/stream">');
    expect(xml).toContain('name="callId" value="call_test"');
    expect(xml).toContain('name="streamToken"');
    expect(xml).toContain('name="userLanguage" value="English"');
    expect(xml).toContain('name="remoteLanguage" value="Spanish"');
    expect(xml).toContain('language="es-ES"');
    expect(xml).toContain('Esta llamada usa traduccion en vivo');
  });

  it('plays custom translated intro blocks before connecting the media stream', () => {
    const xml = buildTranslatedCallTwiMl({
      config,
      callId: 'call_test',
      userLanguage: 'English',
      remoteLanguage: 'Spanish',
      announceTranslationAtStart: true,
      introMessageText: 'Hola, llamo para hacer una reservacion para cinco personas.',
      introDisclaimerText:
        'Estoy usando un traductor en vivo, asi que puede haber unos segundos de silencio antes de mis respuestas. Gracias por su paciencia.'
    });

    expect(xml.indexOf('Hola, llamo para hacer una reservacion')).toBeLessThan(xml.indexOf('<Connect>'));
    expect(xml.indexOf('Estoy usando un traductor en vivo')).toBeLessThan(xml.indexOf('<Connect>'));
    expect(xml).not.toContain('Esta llamada usa traduccion en vivo. Por favor, hable normalmente.');
  });

  it('does not play intro text when the announcement is disabled', () => {
    const xml = buildTranslatedCallTwiMl({
      config,
      callId: 'call_test',
      userLanguage: 'English',
      remoteLanguage: 'Spanish',
      announceTranslationAtStart: false,
      introMessageText: 'Hola, llamo para hacer una reservacion.',
      introDisclaimerText: 'Estoy usando un traductor en vivo.'
    });

    expect(xml).not.toContain('<Say');
    expect(xml).toContain('<Connect>');
  });
});
