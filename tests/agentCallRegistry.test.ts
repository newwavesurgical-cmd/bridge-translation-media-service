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
      languageLock: 'English',
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator."
    });

    const instructions = buildAgentInstructions(session.data);

    expect(instructions).toContain(
      'Your first spoken words must be exactly: "Hey there, just so you know, I am a real person but I\'m using an AI translator."'
    );
    expect(instructions).toContain('speak only in English');
    expect(instructions).toContain('Never ask the person who requested the call for private information out loud');
    expect(instructions).toContain('Never say or imply');
    expect(instructions).toContain('Do not begin the call with a hold phrase');
    expect(instructions).toContain('Never switch persona');
    expect(instructions).toContain('get directly to the concrete purpose of the call');
    expect(instructions).toContain('I am calling about');
    expect(instructions).toContain('Never open with vague agency phrasing');
    expect(instructions).not.toContain('You may say you are calling on behalf of a client or customer');
    expect(instructions).not.toContain('You may say you are calling on behalf');
  });

  it('does not invite customer/client framing even when caller identity is supplied', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask whether the car is still available.',
      languageLock: 'English',
      callerName: 'Alex'
    });

    const instructions = buildAgentInstructions(session.data);

    expect(instructions).toContain('Caller identity: Alex');
    expect(instructions).toContain('Use this only if the remote party asks who is calling');
    expect(instructions).toContain('Never open with vague agency phrasing');
    expect(instructions).not.toContain('calling on behalf of Alex');
  });

  it('ignores duplicate first-utterance enforcement controls from the caller app', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask whether the car is still available.',
      languageLock: 'English'
    });

    const control = session.receiveControl({
      text:
        'FIRST UTTERANCE CONTRACT ENFORCEMENT. Your previous response was off-script; say the exact first words again.'
    });

    expect(control).toMatchObject({
      delivered: false,
      text: 'Ignored duplicate first-utterance contract enforcement; startup is enforced by the media bridge.'
    });
    expect(session.diagnostics()).toMatchObject({
      counters: {
        controlsReceived: 1,
        controlsDelivered: 0
      },
      controlsTail: [
        {
          delivered: false,
          text: 'Ignored duplicate first-utterance contract enforcement; startup is enforced by the media bridge.'
        }
      ],
      transcriptTail: []
    });
  });

  it('adds native Spanish style and constrained hold phrases for Spanish agent calls', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Llama para preguntar como esta Alex y ofrecer apoyo.',
      languageLock: 'es-ES'
    });

    const instructions = buildAgentInstructions(session.data);

    expect(session.diagnostics()).toMatchObject({
      voice: 'cedar',
      missionPromptWasFallback: false,
      missionPromptPreview: 'Llama para preguntar como esta Alex y ofrecer apoyo.'
    });
    expect(instructions).toContain('natural native Spanish-speaking adult');
    expect(instructions).toContain('neutral Latin American Spanish');
    expect(instructions).toContain('Allowed Spanish hold phrases are only');
    expect(instructions).toContain('Do not add "mientras recupero información"');
  });

  it('marks fallback missions in diagnostics instead of silently pretending a full brief exists', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      targetName: 'Alex'
    });

    expect(session.diagnostics()).toMatchObject({
      missionPromptWasFallback: true
    });
    expect(String(session.diagnostics().missionPromptPreview)).toContain('No detailed mission was supplied');
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
      twilioStreamSid: 'MZ123',
      startupDiagnostics: {
        sessionUpdateAcked: false,
        firstUtteranceArmed: false,
        firstUtteranceDelivered: false,
        preArmedAudio: 0,
        firstUtteranceCorrectionSent: false
      }
    });
  });

  it('retains explicit first utterance startup-gate options from the caller app', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_first_utterance_test',
      missionPrompt: 'Ask whether the appointment is available.',
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
      requireLiteralFirstUtterance: true,
      deferFirstResponseUntilSessionReady: true
    });

    expect(session.data).toMatchObject({
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
      requireLiteralFirstUtterance: true,
      deferFirstResponseUntilSessionReady: true
    });
    expect(session.diagnostics()).toMatchObject({
      startupDiagnostics: {
        sessionUpdateAcked: false,
        firstUtteranceArmed: false,
        firstUtteranceDelivered: false,
        preArmedAudio: 0
      }
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
