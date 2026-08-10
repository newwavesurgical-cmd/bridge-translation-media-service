import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { makeStreamToken } from '../src/auth.js';
import { CallRegistry } from '../src/callRegistry.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  PORT: 8787,
  PUBLIC_BASE_URL: 'https://bridge-media.example.com',
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/twilio/stream',
  APP_STREAM_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/app/stream',
  OPENAI_API_KEY: '',
  OPENAI_TRANSLATION_MODEL: 'gpt-realtime-translate',
  OPENAI_SAFETY_IDENTIFIER: 'test-user',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'auth',
  TWILIO_PHONE_NUMBER: '+15551234567',
  BRIDGE_MEDIA_SHARED_SECRET: 'test-secret-long-enough',
  BRIDGE_MEDIA_API_KEY: 'test-service-api-key-long-enough',
  DRY_RUN_CALLS: true
};

class FakeWs extends EventEmitter {
  close(): void {
    this.emit('close');
  }
}

describe('CallSession Twilio pre-start binding', () => {
  it('waits for Twilio start after connected before binding media', () => {
    const registry = new CallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      userLanguage: 'English',
      remoteLanguage: 'Spanish'
    });
    const ws = new FakeWs();

    const connectedResult = session.handleTwilioPreStart(
      ws as never,
      JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' })
    );

    expect(connectedResult).toBe(false);
    expect(session.diagnostics()).toMatchObject({
      twilioConnected: false,
      twilioStreamSid: null
    });

    const startResult = session.handleTwilioPreStart(
      ws as never,
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: 'MZ123',
        start: {
          streamSid: 'MZ123',
          accountSid: 'AC123',
          callSid: 'CA123',
          tracks: ['inbound'],
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8000,
            channels: 1
          },
          customParameters: {
            callId: session.callId,
            streamToken: makeStreamToken(config.BRIDGE_MEDIA_SHARED_SECRET, session.callId)
          }
        }
      })
    );

    expect(startResult).toBe(true);
    expect(session.diagnostics()).toMatchObject({
      callSid: 'CA123',
      twilioConnected: true,
      twilioStreamSid: 'MZ123'
    });
  });

  it('retains transcript diagnostics after a call ends without storing raw audio', async () => {
    const registry = new CallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      userLanguage: 'English',
      remoteLanguage: 'Spanish'
    });

    session.data.transcripts.push(
      {
        at: '2026-08-09T19:00:00.000Z',
        speaker: 'owner',
        kind: 'source',
        delta: 'Can I reserve a table?'
      },
      {
        at: '2026-08-09T19:00:01.000Z',
        speaker: 'owner',
        kind: 'translation',
        delta: 'Puedo reservar una mesa?'
      }
    );
    session.data.counters.transcriptDeltas = 2;

    await session.hangup();

    expect(registry.listRecentDiagnostics()[0]).toMatchObject({
      transcriptDiagnosticNote:
        'In-memory transcript/debug deltas only. Raw audio is not recorded. Cleared on service restart/deploy.',
      transcriptDeltaCount: 2,
      transcriptDeltaRetainedCount: 2,
      transcriptTail: [
        {
          speaker: 'owner',
          kind: 'source',
          delta: 'Can I reserve a table?'
        },
        {
          speaker: 'owner',
          kind: 'translation',
          delta: 'Puedo reservar una mesa?'
        }
      ]
    });
  });

  it('retains sanitized custom intro text in diagnostics', () => {
    const registry = new CallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      userLanguage: 'English',
      remoteLanguage: 'Spanish',
      introMessageText: '  Hola, llamo para una reservacion.  ',
      introDisclaimerText: 'Estoy usando un traductor en vivo.'
    });

    expect(session.diagnostics()).toMatchObject({
      introMessageText: 'Hola, llamo para una reservacion.',
      introDisclaimerText: 'Estoy usando un traductor en vivo.'
    });
  });
});
