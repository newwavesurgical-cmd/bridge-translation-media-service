import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import {
  OpenAiGptLiveVoiceSession,
  buildGptLiveSessionStart,
  resolveGptLiveVoice
} from '../src/openai/gptLiveVoiceSession.js';

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

function makeSession() {
  const sent: Array<Record<string, unknown>> = [];
  const audio: string[] = [];
  const remote: string[] = [];
  const agent: string[] = [];
  const queued = vi.fn();
  const speechStarted = vi.fn();
  const session = new OpenAiGptLiveVoiceSession({
    config,
    instructions: 'LANGUAGE LOCK: Speak only English. Mission fact: appointment at noon.',
    voice: 'echo',
    onAudioDelta: (delta) => audio.push(delta),
    onRemoteTranscriptDelta: (delta) => remote.push(delta),
    onAgentTranscriptDelta: (delta) => agent.push(delta),
    onUserSpeechStarted: speechStarted,
    onStartupEnvelopeQueued: queued,
    onStatus: () => undefined,
    onError: () => undefined
  });
  const mutable = session as unknown as {
    ws: { readyState: number; send: (payload: string) => void };
    handleMessage: (message: string) => void;
  };
  mutable.ws = {
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
  };
  return { session, mutable, sent, audio, remote, agent, queued, speechStarted };
}

describe('GPT-Live voice session', () => {
  it('maps the app voice selection onto natural GPT-Live voices', () => {
    expect(resolveGptLiveVoice('echo')).toBe('meridian');
    expect(resolveGptLiveVoice('coral')).toBe('gleam');
    expect(resolveGptLiveVoice('vesper')).toBe('vesper');
  });

  it('uses native 8 kHz PCMU and delegates mission reasoning to Responses', () => {
    expect(
      buildGptLiveSessionStart({
        liveModel: 'gpt-live-1',
        backendModel: 'gpt-5.6-luna',
        instructions: 'LANGUAGE LOCK: Speak only English. Mission facts.',
        voice: 'echo'
      })
    ).toMatchObject({
      model: 'gpt-live-1',
      audio: {
        format: { type: 'audio/pcmu', rate: 8000 },
        output: { voice: 'meridian' }
      },
      delegation: {
        type: 'responses',
        responses: {
          model: 'gpt-5.6-luna',
          instructions: 'LANGUAGE LOCK: Speak only English. Mission facts.',
          parallel_tool_calls: false
        }
      }
    });
    const instructions = String(
      buildGptLiveSessionStart({
        liveModel: 'gpt-live-1',
        backendModel: 'gpt-5.6-luna',
        instructions: 'LANGUAGE LOCK: Speak only English. Mission facts.',
        voice: 'echo'
      }).instructions
    );
    expect(instructions).toContain('Backchannel policy:');
    expect(instructions).toContain('Interruption policy:');
    expect(instructions).toContain('Delegate to the backend when:');
    expect(instructions).toContain('Single active mission:');
    expect(instructions).toContain('Never borrow a subject, identity, business, warranty, offer, or scenario');
    expect(instructions).toContain('Mission: LANGUAGE LOCK: Speak only English. Mission facts.');
  });

  it('gives the fast voice layer the active mission without replaying the completed opener contract', () => {
    const instructions = String(
      buildGptLiveSessionStart({
        liveModel: 'gpt-live-1',
        backendModel: 'gpt-5.6-luna',
        instructions: [
          'You are a live outbound phone-call voice agent.',
          'Caller identity: Alex. Use this only if asked.',
          'Remote callee/contact: Pamela.',
          'Your first spoken words must be exactly: "Protected opener."',
          'Mission:',
          '=== MISSION (operator brief) ===',
          'Call Pamela to discuss her move to North Carolina.',
          '=== END MISSION ===',
          '=== GENERIC EXAMPLE ===',
          'Secret unrelated appliance warranty example.'
        ].join('\n'),
        voice: 'echo'
      }).instructions
    );

    expect(instructions).toContain('Caller identity: Alex');
    expect(instructions).toContain('Remote callee/contact: Pamela');
    expect(instructions).toContain('Mission: Call Pamela to discuss her move to North Carolina.');
    expect(instructions).not.toContain('Your first spoken words must be exactly: "Protected opener."');
    expect(instructions).not.toContain('Secret unrelated appliance warranty example.');
    expect(instructions).toContain('Never invent vague framing such as a team the callee contacted');
  });

  it('buffers callee audio until the protected TwiML opener boundary is confirmed', () => {
    const { session, mutable, sent, queued } = makeSession();
    session.appendPcmuBase64('before');
    expect(sent).toEqual([]);

    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    expect(queued).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);

    session.confirmStartupEnvelopePlayback();
    expect(sent).toEqual([{ type: 'session.input_audio.append', audio: 'before' }]);

    session.appendPcmuBase64('after');
    expect(sent.at(-1)).toEqual({ type: 'session.input_audio.append', audio: 'after' });
  });

  it('routes live audio and both transcript directions through the existing bridge callbacks', () => {
    const { mutable, audio, remote, agent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'pcmu' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'hello' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Hi' }));
    expect(audio).toEqual(['pcmu']);
    expect(remote).toEqual(['hello']);
    expect(agent).toEqual(['Hi']);
  });

  it('signals barge-in once per continuous remote utterance instead of once per transcript fragment', () => {
    const { mutable, speechStarted } = makeSession();
    mutable.handleMessage(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Can', start_ms: 1000, end_ms: 1180 })
    );
    mutable.handleMessage(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: ' you help', start_ms: 1180, end_ms: 1500 })
    );
    mutable.handleMessage(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: 'One more thing', start_ms: 2100, end_ms: 2500 })
    );

    expect(speechStarted).toHaveBeenCalledTimes(2);
  });

  it('sends operator controls as private live instructions without exposing them as call text', () => {
    const { session, mutable, sent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    session.injectInstruction('Yes, Tuesday works.', 'yes');
    expect(sent[0]).toMatchObject({
      type: 'session.instructions.append',
      delegation_id: null
    });
    expect(String(sent[0].content)).toContain('Never mention the operator');
    expect(sent[1]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null
    });
    expect(String(sent[1].content)).toContain('Yes, Tuesday works.');
  });
});
