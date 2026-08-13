import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeMediaServer } from '../src/http.js';
import { InPersonRegistry } from '../src/inPersonRegistry.js';
import { pcm16ToBase64 } from '../src/audio/codec.js';
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

function pcmChunk(amplitude: number): string {
  return pcm16ToBase64(new Int16Array(480).fill(amplitude));
}

describe('InPersonRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('includes server-side translated audio timing diagnostics', () => {
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_timing_test',
      inputMode: 'single_mic_auto'
    });

    expect(session.diagnostics()).toMatchObject({
      audioTiming: {
        ownerToPartner: {
          inputChunks: 0,
          openAiAudioChunks: 0,
          emittedAudioChunks: 0,
          suppressedAudioChunks: 0,
          maxOpenAiAudioGapMs: 0,
          maxEmitGapMs: 0
        },
        partnerToOwner: {
          inputChunks: 0,
          openAiAudioChunks: 0,
          emittedAudioChunks: 0,
          suppressedAudioChunks: 0,
          maxOpenAiAudioGapMs: 0,
          maxEmitGapMs: 0
        }
      },
      audioTimingTail: []
    });
  });

  it('allows phone-only auto sessions to be manually routed to one language side', () => {
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_auto_override_test',
      inputMode: 'single_mic_auto'
    });

    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'auto',
      activeSingleMicRoute: 'auto',
      routeOverride: false
    });

    (session as unknown as { handleAppMessage(raw: string): void }).handleAppMessage(
      JSON.stringify({ type: 'set_single_mic_route', route: 'partner' })
    );

    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      activeSingleMicRoute: 'partner',
      routeOverride: true
    });

    (session as unknown as { handleAppMessage(raw: string): void }).handleAppMessage(
      JSON.stringify({ type: 'set_single_mic_route', route: 'auto' })
    );

    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'auto',
      activeSingleMicRoute: 'auto',
      routeOverride: false
    });
  });

  it('keeps a manual single-mic route for the utterance and returns to auto after silence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_auto_temporary_override_test',
      inputMode: 'single_mic_auto'
    });
    const handle = (session as unknown as { handleAppMessage(raw: string): void }).handleAppMessage.bind(session);
    const updateTemporaryRoute = (
      session as unknown as { updateTemporarySingleMicRoute(audio: string): void }
    ).updateTemporarySingleMicRoute.bind(session);

    handle(JSON.stringify({ type: 'set_single_mic_route', route: 'partner' }));
    updateTemporaryRoute(pcmChunk(0));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      routeOverride: true,
      routeOverrideSpeechAgeMs: null
    });

    updateTemporaryRoute(pcmChunk(6000));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      routeOverride: true
    });

    vi.advanceTimersByTime(30000);
    updateTemporaryRoute(pcmChunk(6000));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      routeOverride: true
    });

    vi.advanceTimersByTime(1799);
    updateTemporaryRoute(pcmChunk(0));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      routeOverride: true
    });

    vi.advanceTimersByTime(2);
    updateTemporaryRoute(pcmChunk(6000));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'partner',
      routeOverride: true
    });

    vi.advanceTimersByTime(1801);
    updateTemporaryRoute(pcmChunk(0));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'auto',
      activeSingleMicRoute: 'auto',
      routeOverride: false,
      routeOverrideSpeechAgeMs: null
    });
  });

  it('returns an unused manual single-mic route to auto if speech never starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const registry = new InPersonRegistry(config);
    const session = registry.create({
      userLanguage: 'English',
      partnerLanguage: 'Spanish',
      clientSessionId: 'inperson_auto_unused_override_test',
      inputMode: 'single_mic_auto'
    });
    const handle = (session as unknown as { handleAppMessage(raw: string): void }).handleAppMessage.bind(session);
    const updateTemporaryRoute = (
      session as unknown as { updateTemporarySingleMicRoute(audio: string): void }
    ).updateTemporarySingleMicRoute.bind(session);

    handle(JSON.stringify({ type: 'set_single_mic_route', route: 'owner' }));
    vi.advanceTimersByTime(4999);
    updateTemporaryRoute(pcmChunk(0));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'owner',
      routeOverride: true
    });

    vi.advanceTimersByTime(2);
    updateTemporaryRoute(pcmChunk(0));
    expect(session.diagnostics()).toMatchObject({
      singleMicRoute: 'auto',
      routeOverride: false
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
