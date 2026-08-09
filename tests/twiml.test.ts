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
    expect(xml).toContain('This call is using live translation');
  });
});
