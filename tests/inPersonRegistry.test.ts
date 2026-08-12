import { describe, expect, it } from 'vitest';
import { createBridgeMediaServer } from '../src/http.js';
import { InPersonRegistry } from '../src/inPersonRegistry.js';
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
  OPENAI_FILLER_TTS_VOICE_MALE: 'onyx',
  OPENAI_FILLER_TTS_VOICE_FEMALE: 'nova',
  OPENAI_SAFETY_IDENTIFIER: 'test-user',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'auth',
  TWILIO_PHONE_NUMBER: '+15551234567',
  BRIDGE_MEDIA_SHARED_SECRET: 'test-secret-long-enough',
  BRIDGE_MEDIA_API_KEY: 'test-service-api-key-long-enough',
  DRY_RUN_CALLS: true
};

describe('InPersonRegistry', () => {
  it('creates a native dual-channel session with an in-person websocket URL', () => {
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_test'
    });

    expect(session.streamUrl()).toMatch(/^wss:\/\/bridge-media\.example\.com\/in-person\/stream\/inperson_test\?token=/);
    expect(session.diagnostics()).toMatchObject({
      sessionId: 'inperson_test',
      mode: 'in-person-native-dual-channel',
      inputMode: 'dual_channel',
      phoneOnlyMode: false,
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      appConnected: false,
      sessionA: 'idle',
      sessionB: 'idle',
      languageGateMode: 'monitor',
      languageGate: {
        owner: {
          mode: 'monitor',
          expectedLanguage: 'English',
          suppressed: false
        },
        partner: {
          mode: 'monitor',
          expectedLanguage: 'Spanish',
          suppressed: false
        }
      }
    });
  });

  it('creates a phone-only hold-to-speak session without enabling suppression by default', () => {
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_hold_test',
      inputMode: 'single_mic_hold_to_speak'
    });

    expect(session.diagnostics()).toMatchObject({
      sessionId: 'inperson_hold_test',
      mode: 'in-person-phone-hold-to-speak',
      inputMode: 'single_mic_hold_to_speak',
      phoneOnlyMode: true,
      languageGateMode: 'monitor',
      languageGate: {
        owner: {
          mode: 'monitor',
          expectedLanguage: 'English'
        },
        partner: {
          mode: 'monitor',
          expectedLanguage: 'Spanish'
        }
      }
    });
  });

  it('defaults phone-only auto routing to soft language suppression', () => {
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_auto_test',
      inputMode: 'single_mic_auto'
    });

    expect(session.diagnostics()).toMatchObject({
      sessionId: 'inperson_auto_test',
      mode: 'in-person-phone-auto-language-routing',
      inputMode: 'single_mic_auto',
      phoneOnlyMode: true,
      languageGateMode: 'soft_suppress',
      languageGate: {
        owner: {
          mode: 'soft_suppress',
          expectedLanguage: 'English'
        },
        partner: {
          mode: 'soft_suppress',
          expectedLanguage: 'Spanish'
        }
      }
    });
  });
});

describe('in-person HTTP endpoint', () => {
  it('wires the in-person registry into the media server factory', () => {
    const { inPersonRegistry } = createBridgeMediaServer(config);
    const session = inPersonRegistry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_http_test'
    });

    expect(session.streamUrl()).toContain('/in-person/stream/inperson_http_test?token=');
    expect(inPersonRegistry.listDiagnostics()).toMatchObject([
      {
        sessionId: 'inperson_http_test',
        mode: 'in-person-native-dual-channel',
        userLanguage: 'English',
        partnerLanguage: 'Spanish'
      }
    ]);
  });
});
