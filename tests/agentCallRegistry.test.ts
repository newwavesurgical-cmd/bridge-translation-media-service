import { describe, expect, it, vi } from 'vitest';
import { makeStreamToken } from '../src/auth.js';
import { bytesToBase64 } from '../src/audio/codec.js';
import { encodeMuLaw } from '../src/audio/mulaw.js';
import {
  AgentCallRegistry,
  buildAgentInstructions,
  detectConversationalAnsweringService,
  detectIvrPrompt
} from '../src/agentCallRegistry.js';
import type { AppConfig } from '../src/config.js';
import { createBridgeMediaServer } from '../src/http.js';
import { buildAgentCallCreateOptions } from '../src/twilio/client.js';
import { buildAgentCallTwiMl } from '../src/twilio/twiml.js';

const config: AppConfig = {
  PORT: 8787,
  PUBLIC_BASE_URL: 'https://bridge-media.example.com',
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/twilio/stream',
  APP_STREAM_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/app/stream',
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_TRANSLATION_MODEL: 'gpt-realtime-translate',
  OPENAI_AGENT_MODEL: 'gpt-realtime-2.1',
  OPENAI_GPT_LIVE_MODEL: 'gpt-live-1',
  OPENAI_GPT_LIVE_BACKEND_MODEL: 'gpt-5.6-luna',
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

function makeSpeechPayload(frequency = 440): string {
  const sampleRate = 8000;
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i += 1) {
    const t = i / sampleRate;
    pcm[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * 12000);
  }
  return bytesToBase64(encodeMuLaw(pcm));
}

describe('AgentCallRegistry', () => {
  it('creates agent-call sessions with language lock and control diagnostics', async () => {
    const registry = new AgentCallRegistry(config);
    const session = registry.create({
      to: '+15551230000',
      clientSessionId: 'agent_test',
      targetName: 'Electric Company',
      missionPrompt: 'Call about a bill issue.',
      languageLock: 'English',
      spokenPurpose: "I'm calling about a problem with my electric bill."
    });

    const control = await session.receiveControl({ control: 'yes' });

    expect(control.text).toContain('Resolve the active question as yes');
    expect(session.diagnostics()).toMatchObject({
      sessionId: 'agent_test',
      state: 'created',
      languageLock: 'English',
      preparedSpokenPurpose: true,
      monitorStreamSupported: true,
      counters: {
        controlsReceived: 1
      }
    });
  });

  it('routes force_say into the deterministic exact-speech path', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Confirm an appointment.',
      languageLock: 'English'
    });

    const control = await session.receiveControl({
      kind: 'force_say',
      text: 'Tuesday at three works for me.'
    });

    expect(control).toMatchObject({
      delivered: false,
      error: 'The live phone media stream is not ready for exact speech.'
    });
  });

  it('records the requested GPT-Live engine and defaults old callers to realtime', () => {
    const registry = new AgentCallRegistry(config);
    const live = registry.create({
      to: '+15551230000',
      missionPrompt: 'Confirm an appointment.',
      languageLock: 'English',
      agentEngine: 'gpt-live-1'
    });
    const standard = registry.create({
      to: '+15551230001',
      missionPrompt: 'Confirm an appointment.',
      languageLock: 'English'
    });

    expect(live.data.agentEngine).toBe('gpt-live-1');
    expect(live.diagnostics()).toMatchObject({
      agentEngine: 'gpt-live-1',
      realtimeModel: 'gpt-live-1'
    });
    expect(standard.data.agentEngine).toBe('realtime');
  });

  it('builds instructions that prevent operator questions from being spoken aloud', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Schedule a pickup.',
      languageLock: 'English',
      firstUtterance:
        "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling."
    });

    const instructions = buildAgentInstructions(session.data);

    expect(instructions).toContain(
      'Your first spoken words must be exactly: "I\'m Not a telemarketer. I\'m using a translator app since my English is limited. I\'m calling."'
    );
    expect(instructions).toContain('speak only in English');
    expect(instructions).toContain('Never ask the person who requested the call for private information out loud');
    expect(instructions).toContain('ABSOLUTE OPERATOR BOUNDARY');
    expect(instructions).toContain('Caller-side facts include patient or child names');
    expect(instructions).toContain('Treat the Mission section as your working call memory');
    expect(instructions).toContain('SINGLE ACTIVE MISSION BOUNDARY');
    expect(instructions).toContain('Never import or continue a subject, identity, business, warranty, offer, or storyline');
    expect(instructions).toContain('Never invent that you are from a team, support department, company, or prior inquiry');
    expect(instructions).toContain('For symptom or medical-context questions');
    expect(instructions).toContain('use every relevant symptom');
    expect(instructions).toContain('Do not treat a known relationship or caller category as missing information');
    expect(instructions).toContain('It is for my son');
    expect(instructions).toContain('Only use a hold phrase for caller-side facts that are truly absent');
    expect(instructions).toContain('Never ask the remote callee to tell you the caller-side fact');
    expect(instructions).toContain('Never say or imply');
    expect(instructions).toContain('Do not begin the call with a hold phrase');
    expect(instructions).toContain('Never switch persona');
    expect(instructions).toContain('get directly to the concrete purpose of the call');
    expect(instructions).toContain('I am calling about');
    expect(instructions).toContain('Never open with vague agency phrasing');
    expect(instructions).toContain('Avoid repetition');
    expect(instructions).toContain('treat it as leaked local assistant noise');
    expect(instructions).toContain('If the operator intentionally supplies words to say now');
    expect(instructions).toContain('llama ahora');
    expect(instructions).toContain('Automated phone menus / IVR');
    expect(instructions).toContain('stop speaking');
    expect(instructions).toContain('route by DTMF privately');
    expect(instructions).toContain('Only speak to an IVR if it explicitly requires a spoken phrase');
    expect(instructions).toContain('A conversational AI answering service is different from a keypad IVR');
    expect(instructions).toContain('Never narrate private reasoning or plans');
    expect(instructions).toContain('HARD COMMITMENT GATE');
    expect(instructions).toContain('as soon as possible');
    expect(instructions).toContain('stop. Do not pick the most convenient option');
    expect(instructions).toContain('continue to the next missing detail instead of restating the purpose');
    expect(instructions).not.toContain('You may say you are calling on behalf of a client or customer');
    expect(instructions).not.toContain('You may say you are calling on behalf');
  });

  it('holds an unapproved scheduling choice until an answer control arrives', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Get the earliest available appointment.',
      languageLock: 'English'
    });
    const suppressActiveOutput = vi.fn();
    const injectInstruction = vi.fn();
    const mutable = session as unknown as {
      agent: {
        suppressActiveOutput: (reason: string) => void;
        injectInstruction: (text: string, semanticControl?: string) => void;
      };
      considerOperatorQuestion: (text: string) => void;
    };
    mutable.agent = { suppressActiveOutput, injectInstruction };

    mutable.considerOperatorQuestion('Um, we have 12 p.m. or');
    const first = session.diagnostics().pendingOperatorQuestion as { id: string };
    mutable.considerOperatorQuestion('Um, we have 12 p.m. or 1 p.m.');

    expect(session.diagnostics()).toMatchObject({
      operatorQuestionTrackingSupported: true,
      pendingOperatorQuestion: {
        id: first.id,
        text: 'Um, we have 12 p.m. or 1 p.m.',
        kind: 'choice',
        blocking: true
      },
      counters: {
        operatorQuestionsDetected: 1,
        operatorQuestionsBlocked: 1,
        operatorQuestionsResolved: 0
      }
    });
    expect(suppressActiveOutput).toHaveBeenCalledTimes(1);

    await session.receiveControl({ control: 'one_moment' });
    expect(session.diagnostics().pendingOperatorQuestion).not.toBeNull();

    await session.receiveControl({ control: 'yes' });
    expect(session.diagnostics()).toMatchObject({
      pendingOperatorQuestion: null,
      counters: { operatorQuestionsResolved: 1 }
    });
  });

  it('latches the real implicit day proposal until the operator explicitly resolves it', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Find out if the car is available and schedule a time to come see it.',
      languageLock: 'English',
      agentEngine: 'gpt-live-1'
    });
    const suppressActiveOutput = vi.fn();
    const injectInstruction = vi.fn();
    const mutable = session as unknown as {
      agent: {
        suppressActiveOutput: (reason: string) => void;
        injectInstruction: (text: string, semanticControl?: string) => void;
      };
      considerOperatorQuestion: (text: string) => void;
    };
    mutable.agent = { suppressActiveOutput, injectInstruction };

    mutable.considerOperatorQuestion('Yeah, it sure would. Um, Wednesday would be great');

    expect(session.diagnostics()).toMatchObject({
      pendingOperatorQuestion: {
        text: 'Yeah, it sure would. Um, Wednesday would be great',
        kind: 'commitment',
        blocking: true
      },
      counters: {
        operatorQuestionsDetected: 1,
        operatorQuestionsBlocked: 1,
        operatorQuestionsResolved: 0
      }
    });
    expect(suppressActiveOutput).toHaveBeenCalledTimes(1);

    await session.receiveControl({ control: 'one_moment' });
    expect(session.diagnostics().pendingOperatorQuestion).not.toBeNull();

    await session.receiveControl({ text: 'Wednesday does not work. Ask whether Thursday is available.' });
    expect(session.diagnostics()).toMatchObject({
      pendingOperatorQuestion: null,
      counters: { operatorQuestionsResolved: 1 }
    });
  });

  it('replaces an old unresolved alert when the callee asks a new blocking question', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Schedule an appointment.',
      languageLock: 'English'
    });
    const mutable = session as unknown as {
      agent: { suppressActiveOutput: (reason: string) => void };
      considerOperatorQuestion: (text: string) => void;
    };
    mutable.agent = { suppressActiveOutput: () => undefined };

    mutable.considerOperatorQuestion('Can we do next Wednesday');
    const oldId = (session.diagnostics().pendingOperatorQuestion as { id: string }).id;
    mutable.considerOperatorQuestion('We have 12 p.m. or 1 p.m.');
    const pending = session.diagnostics().pendingOperatorQuestion as { id: string; text: string };

    expect(pending.id).not.toBe(oldId);
    expect(pending.text).toBe('We have 12 p.m. or 1 p.m.');
  });

  it('dismisses a false-positive pending question without speaking to the callee', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Handle a routine call.',
      languageLock: 'English'
    });
    const injectInstruction = vi.fn();
    const mutable = session as unknown as {
      agent: {
        suppressActiveOutput: (reason: string) => void;
        injectInstruction: (text: string, semanticControl?: string) => void;
      };
      considerOperatorQuestion: (text: string) => void;
    };
    mutable.agent = { suppressActiveOutput: () => undefined, injectInstruction };
    mutable.considerOperatorQuestion('Are you sure you can do twelve');

    const result = await session.receiveControl({ kind: 'dismiss_pending_question' });

    expect(result).toMatchObject({ delivered: true });
    expect(session.diagnostics().pendingOperatorQuestion).toBeNull();
    expect(injectInstruction).not.toHaveBeenCalled();
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

  it('normalizes the truncated default disclosure back to the full first utterance', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English',
      firstUtterance: "I'm Not a telemarketer. I'm using a translator app since my English is limited."
    });

    expect(session.data.firstUtterance).toBe(
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling."
    );
    expect(buildAgentInstructions(session.data)).toContain(
      'Your first spoken words must be exactly: "I\'m Not a telemarketer. I\'m using a translator app since my English is limited. I\'m calling."'
    );
  });

  it('ignores duplicate first-utterance enforcement controls from the caller app', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask whether the car is still available.',
      languageLock: 'English'
    });

    const control = await session.receiveControl({
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

  it('ignores identical operator controls that arrive twice in the debounce window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T04:55:30.000Z'));
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask whether the car is still available.',
      languageLock: 'English'
    });

    const first = await session.receiveControl({ text: 'Pause briefly and continue naturally.' });
    const duplicate = await session.receiveControl({ text: 'Pause briefly and continue naturally.' });
    vi.advanceTimersByTime(1501);
    const later = await session.receiveControl({ text: 'Pause briefly and continue naturally.' });

    expect(first.text).toBe('Pause briefly and continue naturally.');
    expect(duplicate.text).toBe('Ignored duplicate operator control: Pause briefly and continue naturally.');
    expect(later.text).toBe('Pause briefly and continue naturally.');
    expect(session.diagnostics()).toMatchObject({
      counters: {
        controlsReceived: 3,
        controlsDelivered: 0
      },
      transcriptDeltaRetainedCount: 2
    });
  });

  it('shows operator-supplied values instead of internal control wrappers in the transcript', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Complete the intake.'
    });

    await session.receiveControl({ text: '202-555-0147' });
    await session.receiveControl({ control: 'yes' });

    expect(session.diagnostics()).toMatchObject({
      transcriptTail: [
        expect.objectContaining({ speaker: 'operator', delta: '202-555-0147' }),
        expect.objectContaining({ speaker: 'operator', delta: 'Yes' })
      ]
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

  it('uses a Spanish-safe voice when the caller app sends an English-biased voice for Spanish', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Llama para confirmar la cita.',
      languageLock: 'es-ES',
      voice: 'echo'
    });

    expect(session.diagnostics()).toMatchObject({
      voice: 'cedar'
    });
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
    expect(xml).not.toContain('<Say');
    expect(xml).not.toContain('<Play');
  });

  it('blocks agent TwiML on synchronous AMD so voicemail cannot cover the disclosure', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_amd_test',
      missionPrompt: 'Confirm store hours.',
      firstUtterance:
        "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.",
      machineDetection: 'DetectMessageEnd',
      asyncAmd: false,
      machineDetectionTimeout: 30
    });

    const options = buildAgentCallCreateOptions(config, session);

    expect(options).toMatchObject({
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd: 'false',
      method: 'GET'
    });
    expect(options.url).toContain('/twiml/agent-call?sessionId=agent_amd_test');
    expect(options.statusCallback).toContain('/twilio/status?sessionId=agent_amd_test');
  });

  it('sends carrier status directly to the authenticated app settlement callback', () => {
    const statusCallbackUrl =
      'https://translator.example.com/api/public/agent-call-status?sessionId=agent_callback_test&callbackToken=signed-token';
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_callback_test',
      statusCallbackUrl
    });

    const options = buildAgentCallCreateOptions(config, session);

    expect(options.statusCallback).toBe(statusCallbackUrl);
    expect(session.diagnostics()).toMatchObject({
      statusCallbackConfigured: true
    });
  });

  it('surfaces sanitized answer and forwarding diagnostics', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_answered_by_test'
    });

    session.applyTwilioMetadata({
      answeredBy: 'machine_end_beep',
      forwardedFrom: '+19545558980',
      callStatus: 'completed',
      twilioDurationSeconds: 137
    });

    expect(session.diagnostics()).toMatchObject({
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd: false,
      answeredBy: 'machine_end_beep',
      forwardedFrom: '********8980',
      twilioStatus: 'completed',
      twilioDurationSeconds: 137
    });
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

  it('normalizes stale first utterance startup-gate text from the caller app', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_first_utterance_test',
      missionPrompt: 'Ask whether the appointment is available.',
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
      requireLiteralFirstUtterance: true,
      deferFirstResponseUntilSessionReady: true
    });

    expect(session.data).toMatchObject({
      firstUtterance: "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.",
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

  it('suppresses reflected agent audio before forwarding Twilio media to OpenAI', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_echo_test'
    });
    const sentToTwilio: string[] = [];
    const appendPcmuBase64 = vi.fn();
    const mutable = session as unknown as {
      twilioWs: { send: (payload: string) => void; close: () => void };
      agent: { status: string; appendPcmuBase64: (payload: string) => void };
      sendTwilioMedia: (payload: string) => void;
      handleTwilioMessage: (raw: string) => void;
    };
    mutable.twilioWs = {
      send: (payload: string) => sentToTwilio.push(payload),
      close: () => undefined
    };
    mutable.agent = { status: 'live', appendPcmuBase64 };
    session.data.twilioStreamSid = 'MZ123';

    const reflectedPayload = makeSpeechPayload(440);
    mutable.sendTwilioMedia(reflectedPayload);
    mutable.handleTwilioMessage(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '2',
        media: { track: 'inbound', payload: reflectedPayload }
      })
    );

    expect(sentToTwilio).toHaveLength(1);
    expect(appendPcmuBase64).not.toHaveBeenCalled();
    expect(session.diagnostics()).toMatchObject({
      counters: {
        agentAudioChunks: 1,
        agentEchoAudioSuppressed: 1,
        twilioMediaChunks: 0
      }
    });
  });

  it('keeps different inbound audio available for barge-in while echo suppression is armed', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_barge_in_test'
    });
    const appendPcmuBase64 = vi.fn();
    const mutable = session as unknown as {
      twilioWs: { send: () => void; close: () => void };
      agent: { status: string; appendPcmuBase64: (payload: string) => void };
      sendTwilioMedia: (payload: string) => void;
      handleTwilioMessage: (raw: string) => void;
    };
    mutable.twilioWs = {
      send: () => undefined,
      close: () => undefined
    };
    mutable.agent = { status: 'live', appendPcmuBase64 };
    session.data.twilioStreamSid = 'MZ123';

    mutable.sendTwilioMedia(makeSpeechPayload(440));
    const remotePayload = makeSpeechPayload(880);
    mutable.handleTwilioMessage(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '2',
        media: { track: 'inbound', payload: remotePayload }
      })
    );

    expect(appendPcmuBase64).toHaveBeenCalledWith(remotePayload);
    expect(session.diagnostics()).toMatchObject({
      counters: {
        agentEchoAudioSuppressed: 0,
        twilioMediaChunks: 1
      }
    });
  });

  it('clears queued Twilio audio when OpenAI detects remote speech started', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_barge_clear_test'
    });
    const sentToTwilio: string[] = [];
    const mutable = session as unknown as {
      twilioWs: { send: (payload: string) => void; close: () => void };
      lastAgentAudioAt: number;
      clearTwilioAudioForBargeIn: () => void;
    };
    mutable.twilioWs = {
      send: (payload: string) => sentToTwilio.push(payload),
      close: () => undefined
    };
    session.data.twilioStreamSid = 'MZ123';
    session.data.startupDiagnostics.startupEnvelopePlaybackConfirmed = true;
    mutable.lastAgentAudioAt = Date.now();

    mutable.clearTwilioAudioForBargeIn();

    expect(sentToTwilio).toHaveLength(1);
    expect(JSON.parse(sentToTwilio[0]) as Record<string, unknown>).toEqual({
      event: 'clear',
      streamSid: 'MZ123'
    });
    expect(session.diagnostics()).toMatchObject({
      counters: {
        bargeInClears: 1
      }
    });
  });

  it('does not clear the protected disclosure and purpose before Twilio confirms playback', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_startup_barge_guard_test'
    });
    const sentToTwilio: string[] = [];
    const mutable = session as unknown as {
      twilioWs: { send: (payload: string) => void; close: () => void };
      clearTwilioAudioForBargeIn: () => void;
    };
    mutable.twilioWs = {
      send: (payload: string) => sentToTwilio.push(payload),
      close: () => undefined
    };
    session.data.twilioStreamSid = 'MZ123';

    mutable.clearTwilioAudioForBargeIn();

    expect(sentToTwilio).toEqual([]);
    expect(session.diagnostics()).toMatchObject({ counters: { bargeInClears: 0 } });
  });

  it('releases the startup gate only for the matching Twilio playback marker', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_startup_mark_test'
    });
    const confirmStartupEnvelopePlayback = vi.fn();
    const mutable = session as unknown as {
      startupEnvelopeMarkName?: string;
      agent: { confirmStartupEnvelopePlayback: () => void };
      handleTwilioMessage: (raw: string) => void;
    };
    mutable.startupEnvelopeMarkName = 'startup-final';
    mutable.agent = { confirmStartupEnvelopePlayback };

    mutable.handleTwilioMessage(
      JSON.stringify({ event: 'mark', sequenceNumber: '2', streamSid: 'MZ123', mark: { name: 'other' } })
    );
    expect(confirmStartupEnvelopePlayback).not.toHaveBeenCalled();

    mutable.handleTwilioMessage(
      JSON.stringify({ event: 'mark', sequenceNumber: '3', streamSid: 'MZ123', mark: { name: 'startup-final' } })
    );
    expect(confirmStartupEnvelopePlayback).toHaveBeenCalledTimes(1);
    expect(mutable.startupEnvelopeMarkName).toBeUndefined();
  });

  it('sends DTMF over the agent-call Twilio media stream and records diagnostics', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_dtmf_test'
    });
    const sentToTwilio: string[] = [];
    const mutable = session as unknown as {
      twilioWs: { send: (payload: string) => void; close: () => void };
    };
    mutable.twilioWs = {
      send: (payload: string) => sentToTwilio.push(payload),
      close: () => undefined
    };
    session.data.twilioStreamSid = 'MZ123';

    const dtmf = session.sendDtmf('3');

    expect(dtmf).toMatchObject({ digit: '3', delivered: true });
    expect(sentToTwilio).toHaveLength(1);
    expect(JSON.parse(sentToTwilio[0]) as Record<string, unknown>).toMatchObject({
      event: 'media',
      streamSid: 'MZ123',
      media: { payload: expect.any(String) }
    });
    expect(session.diagnostics()).toMatchObject({
      counters: {
        dtmfSent: 1,
        agentAudioChunks: 1
      },
      dtmfTail: [{ digit: '3', delivered: true }],
      transcriptTail: [{ speaker: 'operator', delta: '[DTMF 3]' }]
    });
  });

  it('streams both call sides to a receive-only monitor socket', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_monitor_test'
    });
    const monitorMessages: string[] = [];
    const monitor = {
      readyState: 1,
      send: (payload: string) => monitorMessages.push(payload),
      on: () => undefined,
      close: () => undefined
    };
    session.bindMonitor(monitor as never);

    const sentToTwilio: string[] = [];
    const mutable = session as unknown as {
      twilioWs: { send: (payload: string) => void; close: () => void };
      agent: { appendPcmuBase64: (payload: string) => void };
      handleTwilioMessage: (raw: string) => void;
    };
    mutable.twilioWs = {
      send: (payload: string) => sentToTwilio.push(payload),
      close: () => undefined
    };
    mutable.agent = { appendPcmuBase64: () => undefined };
    session.data.twilioStreamSid = 'MZ123';

    mutable.handleTwilioMessage(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '2',
        streamSid: 'MZ123',
        media: { track: 'inbound', payload: makeSpeechPayload(510) }
      })
    );
    session.sendDtmf('2');

    const audio = monitorMessages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'monitor_audio');
    expect(audio.map((message) => message.track)).toEqual(expect.arrayContaining(['remote', 'agent']));
    expect(audio.every((message) => message.sampleRate === 24000 && message.encoding === 'pcm16')).toBe(true);
    expect(session.monitorStreamUrl()).toMatch(
      /^wss:\/\/bridge-media\.example\.com\/agent-call\/monitor\/stream\/agent_monitor_test\?token=/
    );
    expect(session.diagnostics()).toMatchObject({
      monitorStreamSupported: true,
      monitorConnected: true
    });
  });

  it('records DTMF attempts before the agent-call Twilio stream is live', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_dtmf_not_live_test'
    });

    const dtmf = session.sendDtmf('1');

    expect(dtmf).toMatchObject({
      digit: '1',
      delivered: false,
      reason: 'Cannot send DTMF before Twilio media stream is live.'
    });
    expect(session.diagnostics()).toMatchObject({
      counters: {
        dtmfSent: 0
      },
      dtmfTail: [{ digit: '1', delivered: false }]
    });
  });

  it('extracts IVR menu options and recommends a mission-matching DTMF route', () => {
    const ivr = detectIvrPrompt(
      'Thank you for calling. For billing, press 1. For appointments and scheduling, press 2. To speak with pharmacy, press 3.',
      'I need to make an appointment with the doctor for my son after surgery.'
    );

    expect(ivr).toMatchObject({
      active: true,
      kind: 'menu',
      options: expect.arrayContaining([
        expect.objectContaining({ digit: '1', label: expect.stringContaining('billing') }),
        expect.objectContaining({ digit: '2', label: expect.stringContaining('appointments') })
      ]),
      recommended: expect.objectContaining({
        digit: '2',
        confidence: expect.any(Number)
      }),
      needsOperatorChoice: false
    });
  });

  it('recognizes a conversational AI answering service without treating it as keypad IVR', () => {
    const transcript = [
      'Please provide your ZIP code.',
      'What is the best callback phone number?',
      'Now provide your policy number.',
      'Take your time. Please let me know when you are ready.',
      'Reply yes or no to continue.'
    ].join(' ');

    expect(detectIvrPrompt(transcript)).toBeNull();
    expect(detectConversationalAnsweringService(transcript)).toMatchObject({
      kind: 'conversational_ai',
      confidence: expect.any(Number)
    });
  });

  it('does not classify one ordinary human intake question as an answering bot', () => {
    expect(detectConversationalAnsweringService('Thanks for calling. What phone number can I reach you at?')).toBeNull();
  });

  it('retains structured intake signals across turns and updates the live agent mode once', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      missionPrompt: 'Ask about travel insurance.'
    });
    const modes: string[] = [];
    const mutable = session as unknown as {
      agent: { setRemoteInteractionMode: (mode: string) => void };
      observeRemoteTranscript: (delta: string) => void;
    };
    mutable.agent = { setRemoteInteractionMode: (mode) => modes.push(mode) };

    mutable.observeRemoteTranscript('Please provide your ZIP code.');
    mutable.observeRemoteTranscript('What is the best callback phone number?');
    mutable.observeRemoteTranscript('Please provide your policy number.');
    mutable.observeRemoteTranscript('Take your time.');

    expect(modes).toEqual(['conversational_ai']);
    expect(session.diagnostics()).toMatchObject({
      remoteParty: { kind: 'conversational_ai' },
      counters: { conversationalAiDetections: 1 }
    });
  });

  it('keeps a real numbered menu classified as IVR even if it mentions an agent', () => {
    const transcript = 'For an automated agent, press 1. To speak with customer service, press 2.';

    expect(detectIvrPrompt(transcript)).toMatchObject({ kind: 'menu' });
    expect(detectConversationalAnsweringService(transcript)).toBeNull();
  });

  it('merges transcript fragments into one IVR option per keypad digit', () => {
    const ivr = detectIvrPrompt(
      'For appointments and, press 2. For scheduling, press 2. For billing, press 1.',
      'Schedule an appointment.'
    );

    expect(ivr?.options.filter((option) => option.digit === '2')).toHaveLength(1);
    const optionTwo = ivr?.options.find((option) => option.digit === '2');
    expect(optionTwo?.label).toContain('appointments and');
    expect(optionTwo?.label).toContain('scheduling');
  });

  it('keeps the answered IVR closed while stale menu text is still in flight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_ivr_cooldown_test',
      missionPrompt: 'Reach the front desk.'
    });
    const mutable = session as unknown as {
      twilioWs: { send: () => void; close: () => void };
      agent: { suppressActiveOutput: () => void };
      observeRemoteTranscript: (delta: string) => void;
    };
    mutable.twilioWs = { send: () => undefined, close: () => undefined };
    mutable.agent = { suppressActiveOutput: () => undefined };
    session.data.twilioStreamSid = 'MZ123';

    mutable.observeRemoteTranscript('For sales press 1. For appointments press 2.');
    expect((session.diagnostics().ivr as { active: boolean }).active).toBe(true);
    session.sendDtmf('2');
    expect((session.diagnostics().ivr as { active: boolean }).active).toBe(false);

    mutable.observeRemoteTranscript('For sales press 1. For appointments press 2.');
    expect((session.diagnostics().ivr as { active: boolean }).active).toBe(false);
    vi.useRealTimers();
  });

  it('detects closed automated recordings without inventing menu options', () => {
    const ivr = detectIvrPrompt(
      'Thank you for calling the Jet Blue Central Baggage Service Team. We are currently closed. Please try again during our normal business hours.',
      'Call JetBlue about a canceled flight.'
    );

    expect(ivr).toMatchObject({
      active: true,
      kind: 'closed',
      options: [],
      summary: 'Closed or after-hours recording detected.'
    });
  });

  it('records IVR diagnostics and suppresses active agent output after menu detection', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_ivr_test',
      missionPrompt: 'Make an appointment with the doctor for my son.',
      languageLock: 'English'
    });
    let suppressed = 0;
    const mutable = session as unknown as {
      agent: { suppressActiveOutput: (reason: string) => void };
      observeRemoteTranscript: (delta: string) => void;
    };
    mutable.agent = {
      suppressActiveOutput: () => {
        suppressed += 1;
      }
    };

    mutable.observeRemoteTranscript('For billing press 1. For appointments press 2.');

    expect(suppressed).toBe(1);
    expect(session.diagnostics()).toMatchObject({
      ivrMenuDetectionSupported: true,
      ivr: {
        active: true,
        kind: 'menu',
        options: expect.arrayContaining([expect.objectContaining({ digit: '2', label: 'appointments' })]),
        recommended: expect.objectContaining({ digit: '2' })
      },
      counters: {
        ivrDetections: 1
      }
    });
  });

  it('exposes a direct voice takeover app stream for active agent calls', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_test',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });

    const takeover = session.startTakeover({
      userLanguage: 'Spanish',
      remoteLanguage: 'English'
    });

    expect(takeover).toMatchObject({
      active: true,
      userLanguage: 'Spanish',
      remoteLanguage: 'English'
    });
    expect(takeover.appStreamUrl).toMatch(
      /^wss:\/\/bridge-media\.example\.com\/agent-call\/app\/stream\/agent_takeover_test\?token=/
    );
    expect(session.diagnostics()).toMatchObject({
      directVoiceTakeoverSupported: true,
      takeoverActive: true,
      takeoverAppConnected: false,
      takeover: {
        active: true,
        userLanguage: 'Spanish',
        remoteLanguage: 'English'
      },
      takeoverTranslationSessions: {
        ownerToRemote: 'connecting',
        remoteToOwner: 'connecting'
      }
    });
  });

  it('uses the active call lock for takeover even when a stale client sends another remote language', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_language_guard_test',
      missionPrompt: 'Schedule a landscaping estimate.',
      languageLock: 'es-ES'
    });

    const takeover = session.startTakeover({
      userLanguage: 'en-US',
      remoteLanguage: 'en-US'
    });

    expect(takeover).toMatchObject({
      active: true,
      userLanguage: 'en-US',
      remoteLanguage: 'es-ES'
    });
    expect(session.diagnostics()).toMatchObject({
      takeover: { userLanguage: 'en-US', remoteLanguage: 'es-ES' }
    });
  });

  it('turns direct voice takeover off without ending the agent call', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_stop_test',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });

    session.markCalling();
    session.startTakeover({ userLanguage: 'Spanish', remoteLanguage: 'English' });
    session.stopTakeover();

    expect(session.diagnostics()).toMatchObject({
      state: 'created',
      takeoverActive: false,
      takeover: {
        active: false,
        userLanguage: 'Spanish',
        remoteLanguage: 'English'
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
        monitorStreamSupported: true
      }
    ]);
  });
});
