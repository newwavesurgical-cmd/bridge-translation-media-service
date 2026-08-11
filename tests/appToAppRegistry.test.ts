import { describe, expect, it } from 'vitest';
import { createBridgeMediaServer } from '../src/http.js';
import { AppToAppRegistry } from '../src/appToAppRegistry.js';
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

describe('AppToAppRegistry', () => {
  it('creates a two-phone app-to-app session with signed participant websocket URLs', () => {
    const registry = new AppToAppRegistry(config);
    const session = registry.create({
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      clientSessionId: 'app2app_test'
    });

    expect(session.participantStreamUrl('initiator')).toMatch(
      /^wss:\/\/bridge-media\.example\.com\/app-to-app\/stream\/app2app_test\/initiator\?token=/
    );
    expect(session.participantStreamUrl('receiver')).toMatch(
      /^wss:\/\/bridge-media\.example\.com\/app-to-app\/stream\/app2app_test\/receiver\?token=/
    );
    expect(session.inviteCode).toMatch(/^[2-9A-Z]{9}$/);
    expect(registry.getByInviteCode(session.inviteCode)).toBe(session);
    expect(session.diagnostics()).toMatchObject({
      sessionId: 'app2app_test',
      inviteCode: session.inviteCode,
      mode: 'app-to-app',
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      initiatorConnected: false,
      receiverConnected: false,
      sessionA: 'idle',
      sessionB: 'idle'
    });
  });

  it('rejects a participant token for the wrong side', () => {
    const registry = new AppToAppRegistry(config);
    const session = registry.create({
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      clientSessionId: 'app2app_token_test'
    });
    const initiatorToken = new URL(session.participantStreamUrl('initiator')).searchParams.get('token') ?? '';

    expect(session.verifyParticipantToken('initiator', initiatorToken)).toBe(true);
    expect(session.verifyParticipantToken('receiver', initiatorToken)).toBe(false);
  });

  it('resolves receiver invite details without exposing the code in the websocket token', () => {
    const registry = new AppToAppRegistry(config);
    const session = registry.create({
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      clientSessionId: 'app2app_invite_test'
    });

    expect(registry.getByInviteCode(` ${session.inviteCode.toLowerCase()} `)).toBe(session);
    expect(registry.getByInviteCode('wrong-code')).toBeUndefined();
    expect(session.receiverInvite()).toMatchObject({
      sessionId: 'app2app_invite_test',
      role: 'receiver',
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      inviteCode: session.inviteCode
    });
    expect(String(session.receiverInvite().receiverStreamUrl)).toContain(
      '/app-to-app/stream/app2app_invite_test/receiver?token='
    );
  });

  it('keeps app-to-app filler settings in diagnostics', () => {
    const registry = new AppToAppRegistry(config);
    const session = registry.create({
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      clientSessionId: 'app2app_filler_test',
      fillerBridgeEnabled: true,
      fillerVoiceGender: 'female',
      predictiveMode: 'restaurant_reservation_v1'
    });

    expect(session.diagnostics()).toMatchObject({
      sessionId: 'app2app_filler_test',
      mode: 'app-to-app',
      fillerBridgeEnabled: true,
      fillerVoiceGender: 'female',
      predictiveMode: 'restaurant_reservation_v1',
      timing: {
        initiator: {
          firstTranslatedAudioLatencyMs: null,
          audioRmsAvgPercent: 0,
          audioRmsPeakPercent: 0
        },
        receiver: {
          firstTranslatedAudioLatencyMs: null,
          audioRmsAvgPercent: 0,
          audioRmsPeakPercent: 0
        }
      },
      counters: {
        fillerAudioChunksToInitiator: 0,
        fillerAudioChunksToReceiver: 0,
        fillerSpeechErrors: 0
      }
    });
  });
});

describe('app-to-app HTTP endpoint', () => {
  it('wires the app-to-app registry into the media server factory', () => {
    const { appToAppRegistry } = createBridgeMediaServer(config);
    const session = appToAppRegistry.create({
      initiatorLanguage: 'English',
      receiverLanguage: 'Spanish',
      clientSessionId: 'app2app_http_test'
    });

    expect(session.participantStreamUrl('receiver')).toContain('/app-to-app/stream/app2app_http_test/receiver?token=');
    expect(session.inviteCode).toMatch(/^[2-9A-Z]{9}$/);
    expect(appToAppRegistry.listDiagnostics()).toMatchObject([
      {
        sessionId: 'app2app_http_test',
        inviteCode: session.inviteCode,
        mode: 'app-to-app',
        initiatorLanguage: 'English',
        receiverLanguage: 'Spanish'
      }
    ]);
  });
});
