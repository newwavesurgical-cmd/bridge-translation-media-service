import { describe, expect, it } from 'vitest';
import { makeStreamToken } from '../src/auth.js';
import { AgentCallRegistry, buildAgentInstructions } from '../src/agentCallRegistry.js';
import type { AppConfig } from '../src/config.js';
import { createBridgeMediaServer } from '../src/http.js';
import { buildAgentCallTwiMl } from '../src/twilio/twiml.js';

const config: AppConfig = {
  PORT: 8787,
  PUBLIC_BASE_URL: 'https://bridge-media.example.com',
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/twilio/stream',
  APP_STREAM_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/app/stream',
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_TRANSLATION_MODEL: 'gpt-realtime-translate',
  OPENAI_AGENT_MODEL: 'gpt-realtime-2.1',
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

describe('AgentCallRegistry', () => {
  it('creates agent-call sessions with language lock and control diagnostics', () => {
    const registry = new AgentCallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      clientSessionId: 'agent_test',
      targetName: 'Electric Company',
      missionPrompt: 'Call about a bill issue.',
      languageLock: 'English'
    });

    const control = session.receiveControl({ control: 'yes' });

    expect(control.text).toContain('Resolve the active question as yes');
    expect(session.diagnostics()).toMatchObject({
      sessionId: 'agent_test',
      state: 'created',
      languageLock: 'English',
      monitorStreamSupported: false,
      counters: {
        controlsReceived: 1
      }
    });
  });

  it('builds instructions that prevent operator questions from being spoken aloud', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Schedule a pickup.',
      languageLock: 'English'
    });

    const instructions = buildAgentInstructions(session.data);

    expect(instructions).toContain('speak only in English');
    expect(instructions).toContain('Never ask the operator/user for private information out loud');
    expect(instructions).toContain('Never switch persona');
  });

  it('builds TwiML for the dedicated agent-call Twilio stream', () => {
    const xml = buildAgentCallTwiMl({ config, sessionId: 'agent_test' });

    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream url="wss://bridge-media.example.com/agent-call/twilio/stream">');
    expect(xml).toContain('name="sessionId" value="agent_test"');
    expect(xml).toContain('name="streamToken"');
  });

  it('waits for Twilio start before binding the realtime voice session', () => {
    const registry = new AgentCallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      clientSessionId: 'agent_twilio_test'
    });
    const fakeWs = { on: () => undefined, close: () => undefined, send: () => undefined };

    const connectedResult = session.handleTwilioPreStart(
      fakeWs as never,
      JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' })
    );

    expect(connectedResult).toBe(false);
    expect(session.diagnostics()).toMatchObject({ twilioConnected: false });

    const startResult = session.handleTwilioPreStart(
      fakeWs as never,
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
            sessionId: session.sessionId,
            streamToken: makeStreamToken(config.BRIDGE_MEDIA_SHARED_SECRET, session.sessionId)
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
});

describe('agent-call HTTP endpoint wiring', () => {
  it('wires the agent-call registry into the media server factory', () => {
    const { agentCallRegistry } = createBridgeMediaServer(config);
    const session = agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_http_test',
      missionPrompt: 'Confirm store hours.'
    });

    session.markCalling();

    expect(agentCallRegistry.listDiagnostics()).toMatchObject([
      {
        sessionId: 'agent_http_test',
        realtimeModel: 'gpt-realtime-2.1',
        monitorStreamSupported: false
      }
    ]);
  });
});
