import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { AgentOutputContext } from '../src/openai/agentVoiceSession.js';
import { encodeMuLaw } from '../src/audio/mulaw.js';
import {
  OpenAiGptLiveVoiceSession,
  buildGptLiveConversationInstructions,
  buildGptLiveOpeningDirective,
  buildGptLiveSessionStart,
  resolveGptLiveVoice
} from '../src/openai/gptLiveVoiceSession.js';

describe('GPT-Live decision mode instructions', () => {
  it('keeps routine choices moving in best-judgment mode', () => {
    const instructions = buildGptLiveConversationInstructions(
      'Language lock: en-US. DECISION PADDLE — USE BEST JUDGMENT. Mission: book the earliest Sunday appointment.'
    );
    expect(instructions).toContain('BEST-JUDGMENT MODE');
    expect(instructions).toContain('select the earliest option');
    expect(instructions).toContain('Ask the remote business directly for its availability');
    expect(instructions).toContain('If the callee says you are talking over them');
  });
});

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

const speechAudio = Buffer.from(encodeMuLaw(Int16Array.from(
  { length: 800 }, (_, i) => Math.round(Math.sin(i * 0.35) * 5000)
))).toString('base64');
const quietAudio = Buffer.alloc(4000, 255).toString('base64');

function makeSession(input?: { disclosureEnabled?: boolean; firstUtterance?: string; spokenPurpose?: string; instructions?: string }) {
  const sent: Array<Record<string, unknown>> = [];
  const audio: string[] = [];
  const remote: string[] = [];
  const agent: string[] = [];
  const audioContexts: Array<AgentOutputContext | undefined> = [];
  const agentContexts: Array<AgentOutputContext | undefined> = [];
  const queued = vi.fn();
  const speechStarted = vi.fn();
  const playbackMarks: string[] = [];
  const session = new OpenAiGptLiveVoiceSession({
    config,
    instructions: input?.instructions ?? 'LANGUAGE LOCK: Speak only English. Mission fact: appointment at noon.',
    disclosureEnabled: input?.disclosureEnabled ?? true,
    firstUtterance: input?.firstUtterance ?? "I'm not a telemarketer.",
    spokenPurpose: input?.spokenPurpose ?? 'I am calling to confirm the appointment time.',
    voice: 'echo',
    onAudioDelta: (delta, context) => {
      audio.push(delta);
      audioContexts.push(context);
    },
    onRemoteTranscriptDelta: (delta) => remote.push(delta),
    onAgentTranscriptDelta: (delta, context) => {
      agent.push(delta);
      agentContexts.push(context);
    },
    onUserSpeechStarted: speechStarted,
    onPlaybackCheckpoint: (name) => playbackMarks.push(name),
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
  return {
    session,
    mutable,
    sent,
    audio,
    remote,
    agent,
    audioContexts,
    agentContexts,
    queued,
    speechStarted,
    playbackMarks,
    finishPlayback: () => {
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: quietAudio }));
      expect(playbackMarks.at(-1)).toBeTruthy();
      session.confirmPlaybackCheckpoint(playbackMarks.at(-1)!);
    }
  };
}

function readyControlSession() {
  const fixture = makeSession();
  fixture.mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
  fixture.mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
  fixture.mutable.handleMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }));
  fixture.sent.splice(0);
  const acknowledge = () => {
    for (const payload of fixture.sent.filter((p) =>
      p.type === 'session.instructions.append' || p.type === 'session.commentary.append')) {
      fixture.mutable.handleMessage(JSON.stringify({
        type: `${payload.type}ed`, client_event_id: payload.event_id
      }));
    }
  };
  return { ...fixture, acknowledge };
}

describe('GPT-Live voice session', () => {
  it('finishes a short answer at confirmed playback without waiting ten seconds or an API done event', async () => {
    const { session, mutable, acknowledge, finishPlayback } = readyControlSession();
    const result = session.injectInstruction('Yes, Wednesday works.', 'yes');
    acknowledge();
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    finishPlayback();
    await expect(result).resolves.toMatchObject({ delivered: true, audioCompleted: true, retryCount: 0 });
  });

  it('does not confuse continuously streamed silence with an audible answer', async () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, acknowledge, playbackMarks } = readyControlSession();
      const result = session.injectInstruction('Yes, Wednesday works.', 'yes');
      acknowledge();
      for (let i = 0; i < 8; i++) {
        mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: quietAudio }));
        vi.advanceTimersByTime(500);
      }
      expect(playbackMarks).toEqual([]);
      await expect(result).resolves.toMatchObject({ delivered: false, audioStarted: false, errorCode: 'control_audio_timeout' });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('waits for playback of resumed speech instead of accepting a stale quiet-boundary mark', async () => {
    const { session, mutable, acknowledge, playbackMarks, finishPlayback } = readyControlSession();
    const result = session.injectInstruction('A longer operator answer.', 'yes');
    acknowledge();
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: quietAudio }));
    const staleMark = playbackMarks.at(-1)!;
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    let settled = false;
    void result.then(() => { settled = true; });
    session.confirmPlaybackCheckpoint(staleMark);
    await Promise.resolve();
    expect(settled).toBe(false);
    finishPlayback();
    await expect(result).resolves.toMatchObject({ audioCompleted: true });
  });

  it('requests a playback checkpoint when output stops sending packets after speech', async () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, acknowledge, playbackMarks } = readyControlSession();
      const result = session.injectInstruction('No, thank you.', 'no');
      acknowledge();
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
      vi.advanceTimersByTime(650);
      expect(playbackMarks).toHaveLength(1);
      session.confirmPlaybackCheckpoint(playbackMarks[0]);
      await expect(result).resolves.toMatchObject({ audioCompleted: true });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('does not release a long answer at a fixed ten-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, acknowledge, finishPlayback } = readyControlSession();
      const result = session.injectInstruction('Deliver this longer answer.', 'yes');
      acknowledge();
      let settled = false;
      void result.then(() => { settled = true; });
      for (let i = 0; i < 30; i++) {
        mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(settled).toBe(false);
      finishPlayback();
      await expect(result).resolves.toMatchObject({ audioCompleted: true });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('releases an interrupted answer without calling a cleared Twilio mark completed speech', async () => {
    const { session, mutable, acknowledge, playbackMarks } = readyControlSession();
    const result = session.injectInstruction('Wednesday works for me.', 'yes');
    acknowledge();
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: quietAudio }));
    session.notifyPlaybackCleared();
    session.confirmPlaybackCheckpoint(playbackMarks[0]);
    await expect(result).resolves.toMatchObject({ delivered: true, audioStarted: true, audioCompleted: false });
  });

  it('updates settled call facts as quiet context without restarting the session or speaking them', () => {
    const { session, sent } = readyControlSession();
    session.appendConversationContext('Wednesday was approved. Time has not been chosen.');
    expect(sent).toEqual([expect.objectContaining({
      type: 'session.thinking.append', delegation_id: null,
      content: 'Wednesday was approved. Time has not been chosen.'
    })]);
  });

  it('keeps the call alive if an optional context refresh is rejected', () => {
    const { session, mutable, sent } = readyControlSession();
    session.appendConversationContext('Wednesday was approved.');
    mutable.handleMessage(JSON.stringify({ type: 'error', error: {
      client_event_id: sent[0].event_id, code: 'context_rejected', message: 'Rejected context'
    } }));
    expect(session.status).toBe('live');
  });

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
    expect(instructions).toContain('remain the outbound caller throughout holds and private answers');
    expect(instructions).toContain('do not choose a time without separate approval');
    expect(instructions).toContain('A mid-call hello, hola');
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

  it('streams real callee audio continuously while the single GPT-Live opener is playing', () => {
    const { session, mutable, sent, queued } = makeSession();
    session.appendPcmuBase64('before');
    expect(sent).toEqual([]);

    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    expect(queued).not.toHaveBeenCalled();
    expect(sent.map((payload) => payload.type)).toEqual([
      'session.instructions.append',
      'session.input_audio.append'
    ]);
    expect(sent[1]?.audio).toBe('before');

    session.appendPcmuBase64('during-opening');
    expect(sent.at(-1)).toEqual({ type: 'session.input_audio.append', audio: 'during-opening' });

    mutable.handleMessage(
      JSON.stringify({
        type: 'session.instructions.appended',
        client_event_id: sent[0]?.event_id
      })
    );
    expect(sent.at(-1)?.type).toBe('session.commentary.append');

    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    expect(queued).toHaveBeenCalledOnce();

    session.confirmStartupEnvelopePlayback();

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

  it('tags automatic hold speech so the bridge can pass only that same-voice output through a decision hold', () => {
    const { session, mutable, sent, audioContexts, agentContexts } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    session.confirmStartupEnvelopePlayback();
    sent.splice(0);

    void session.injectInstruction(
      'Say exactly one brief holding sentence, then listen.',
      'operator_decision_hold'
    );
    mutable.handleMessage(
      JSON.stringify({ type: 'session.output_transcript.delta', delta: 'One moment, please.' })
    );
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'hold-audio' }));

    expect(agentContexts.at(-1)).toEqual({
      kind: 'intervention',
      semanticControl: 'operator_decision_hold'
    });
    expect(audioContexts.at(-1)).toEqual({
      kind: 'intervention',
      semanticControl: 'operator_decision_hold'
    });
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

  it('confirms operator delivery only after correlated acknowledgments and response audio', async () => {
    const { session, mutable, sent, finishPlayback } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    session.confirmStartupEnvelopePlayback();
    sent.splice(0);
    const delivery = session.injectInstruction('Yes, Tuesday works.', 'yes');
    let settled = false;
    void delivery.then(() => {
      settled = true;
    });
    expect(sent[0]).toMatchObject({
      type: 'session.instructions.append',
      delegation_id: null
    });
    expect(String(sent[0].content)).toContain('Never mention the operator');
    expect(sent[1]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null
    });
    expect(String(sent[1].content)).toContain('callee-facing answer');
    expect(String(sent[1].content)).not.toContain('Yes, Tuesday works.');

    mutable.handleMessage(
      JSON.stringify({
        type: 'session.instructions.appended',
        client_event_id: sent[0]?.event_id
      })
    );
    mutable.handleMessage(
      JSON.stringify({
        type: 'session.commentary.appended',
        client_event_id: sent[1]?.event_id
      })
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    await Promise.resolve();
    expect(settled).toBe(false);
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    await Promise.resolve();
    expect(settled).toBe(false); // Live has no such event; it is not playback proof.
    finishPlayback();
    await expect(delivery).resolves.toMatchObject({
      delivered: true,
      acknowledged: true,
      audioStarted: true,
      audioCompleted: true,
      retryCount: 0
    });
  });

  it('does not retry an acknowledged operator response when audio begins inside the extended grace', async () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, sent, finishPlayback } = makeSession();
      mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
      sent.splice(0);

      const delivery = session.injectInstruction('No, Thursday is better.', 'no');
      mutable.handleMessage(
        JSON.stringify({ type: 'session.instructions.appended', client_event_id: sent[0]?.event_id })
      );
      mutable.handleMessage(
        JSON.stringify({ type: 'session.commentary.appended', client_event_id: sent[1]?.event_id })
      );

      vi.advanceTimersByTime(1_400);
      expect(sent.filter((payload) => payload.type === 'session.commentary.append')).toHaveLength(1);
      vi.advanceTimersByTime(500);
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
      finishPlayback();

      await expect(delivery).resolves.toMatchObject({
        delivered: true,
        acknowledged: true,
        audioStarted: true,
        audioCompleted: true,
        retryCount: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries once when an append acknowledgment is still missing at the first deadline', async () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, sent, finishPlayback } = readyControlSession();
      const delivery = session.injectInstruction('No, Thursday is better.', 'no');
      mutable.handleMessage(
        JSON.stringify({ type: 'session.instructions.appended', client_event_id: sent[0]?.event_id })
      );

      vi.advanceTimersByTime(1_400);
      const commentary = sent.filter((payload) => payload.type === 'session.commentary.append');
      expect(commentary).toHaveLength(2);
      expect(String(commentary[1]?.content)).toContain('callee-facing answer was not acknowledged');
      mutable.handleMessage(
        JSON.stringify({ type: 'session.commentary.appended', client_event_id: sent[1]?.event_id })
      );
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
      finishPlayback();

      await expect(delivery).resolves.toMatchObject({ delivered: true, retryCount: 1 });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['operator_decision_hold', 'holding sentence'],
    ['resume_autonomy', 'same-call continuation']
  ])('uses control-specific retry wording for %s', (semanticControl, expected) => {
    vi.useFakeTimers();
    try {
      const { session, sent } = readyControlSession();
      void session.injectInstruction('Continue this control safely.', semanticControl, true);
      vi.advanceTimersByTime(1_400);
      const retry = sent.filter((payload) => payload.type === 'session.commentary.append').at(-1);
      expect(String(retry?.content)).toContain(expected);
      expect(String(retry?.content)).not.toContain('operator-directed response');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('confirms a private non-speech control after acknowledgments without waiting for audio', async () => {
    const { session, mutable, sent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    sent.splice(0);

    const delivery = session.injectInstruction(
      'Keep the next response especially concise.',
      'whisper_guidance',
      false
    );
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.content)).toContain('Keep the next response especially concise.');
    mutable.handleMessage(
      JSON.stringify({ type: 'session.instructions.appended', client_event_id: sent[0]?.event_id })
    );

    await expect(delivery).resolves.toMatchObject({
      delivered: true,
      acknowledged: true,
      audioStarted: false,
      retryCount: 0
    });
  });

  it('resumes after a dismissed hold without presenting private resume instructions as words to say', async () => {
    const { session, mutable, sent, finishPlayback } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    sent.splice(0);

    const delivery = session.injectInstruction(
      'Remove the temporary suppression. Dismissal is not approval.',
      'resume_autonomy',
      true
    );

    expect(String(sent[0]?.content)).toContain('Dismissal is not approval');
    expect(String(sent[0]?.content)).not.toContain('Immediately speak the intended');
    expect(String(sent[1]?.content)).toContain('Continue this same phone conversation');
    expect(String(sent[1]?.content)).not.toContain('Remove the temporary suppression');

    mutable.handleMessage(
      JSON.stringify({ type: 'session.instructions.appended', client_event_id: sent[0]?.event_id })
    );
    mutable.handleMessage(
      JSON.stringify({ type: 'session.commentary.appended', client_event_id: sent[1]?.event_id })
    );
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
    finishPlayback();

    await expect(delivery).resolves.toMatchObject({
      delivered: true,
      acknowledged: true,
      audioStarted: true,
      audioCompleted: true
    });
  });

  it('treats a correlated control rejection as recoverable without killing the live session', async () => {
    const { session, mutable, sent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));
    sent.splice(0);

    const delivery = session.injectInstruction('Yes.', 'yes');
    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'control_rejected',
          message: 'Control could not be applied.',
          client_event_id: sent[1]?.event_id
        }
      })
    );

    await expect(delivery).resolves.toMatchObject({
      delivered: false,
      errorCode: 'control_rejected'
    });
    expect(session.status).toBe('live');
  });

  it('uses one GPT-Live voice turn for greeting, disclosure and purpose when the toggle is on', () => {
    const directive = buildGptLiveOpeningDirective({
      disclosure: "I'm not a telemarketer.",
      purpose: 'I am calling about the car you listed.'
    });

    expect(directive).toContain("I'm not a telemarketer.");
    expect(directive).toContain('I am calling about the car you listed.');
    expect(directive).toContain('one natural spoken turn');
    expect(directive).toContain('"Hi. I\'m not a telemarketer. I am calling about the car you listed."');
    expect(directive).toContain('Do not add another greeting');
    expect(directive).toContain('only a natural short pause, not a separate turn');
  });

  it('starts with a brief greeting and mission purpose but no disclosure when the toggle is off', () => {
    const { mutable, sent } = makeSession({
      disclosureEnabled: false,
      firstUtterance: "I'm not a telemarketer.",
      spokenPurpose: 'I am calling about the car you listed.'
    });

    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));

    expect(String(sent[0]?.content)).toContain('I am calling about the car you listed.');
    expect(String(sent[0]?.content)).toContain('There is no disclosure');
    expect(String(sent[0]?.content)).not.toContain("I'm not a telemarketer.");
    expect(String(sent[0]?.content)).toContain('"Hi. I am calling about the car you listed."');
  });

  it.each([
    ['English', 'Hi.', 'I am calling about the listing.'],
    ['en-US', 'Hi.', 'I am calling about the listing.'],
    ['Spanish', 'Hola.', 'Llamo por el anuncio.'],
    ['es-ES', 'Hola.', 'Llamo por el anuncio.'],
    ['Portuguese', 'Olá.', 'Estou ligando sobre o anúncio.'],
    ['pt-BR', 'Olá.', 'Estou ligando sobre o anúncio.']
  ])('uses the outbound %s lock for both startup and live greeting directives', (language, greeting, purpose) => {
    const instructions = `Language lock: speak only in ${language}.\nMission:\nAsk about the listing. Other language examples are not the call language.`;
    const { mutable, sent } = makeSession({ instructions, disclosureEnabled: false, spokenPurpose: purpose });
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    const start = buildGptLiveSessionStart({
      liveModel: 'gpt-live-1', backendModel: 'gpt-5.6-luna', voice: 'echo',
      instructions, disclosureEnabled: false, spokenPurpose: purpose
    });
    for (const directive of [String(start.instructions), String(sent[0].content)]) {
      expect(directive).toContain(JSON.stringify(`${greeting} ${purpose}`));
      expect(directive).toContain('do not wait for another hello');
      expect(directive).not.toContain('no greeting');
    }
  });

  it.each([
    ['English', 'Hi. I am calling about the listing.'],
    ['English', 'Hello, I am calling about the listing.'],
    ['Spanish', 'Hola, llamo por el anuncio.'],
    ['Portuguese', 'Olá. Estou ligando sobre o anúncio.']
  ])('preserves an existing %s custom greeting without adding another', (language, purpose) => {
    const directive = buildGptLiveOpeningDirective({ language, purpose });
    expect(directive).toContain(`Say exactly these words once: ${JSON.stringify(purpose)}.`);
    const withDisclosure = buildGptLiveOpeningDirective({ language, disclosure: purpose, purpose: 'A separate purpose.' });
    expect(withDisclosure).toContain(`Say exactly these words once: ${JSON.stringify(`${purpose} A separate purpose.`)}.`);
  });

  it('uses the explicit English lock rather than a Spanish instruction quoted inside mission data', () => {
    const start = buildGptLiveSessionStart({
      liveModel: 'gpt-live-1', backendModel: 'gpt-5.6-luna', voice: 'echo',
      instructions: 'Language lock: speak only in en-US.\nMission:\nDiscuss a sign saying "speak only Spanish".',
      disclosureEnabled: false, spokenPurpose: 'I am calling about the sign.'
    });
    expect(start.instructions).toContain('Speak English only');
    expect(start.instructions).toContain('"Hi. I am calling about the sign."');
  });

  it('greets then uses the active mission if no prepared purpose exists', () => {
    const directive = buildGptLiveOpeningDirective({ language: 'Spanish' });
    expect(directive).toContain('Say exactly these words once: "Hola."');
    expect(directive).toContain('Then state the concrete reason from the active mission briefly');
    expect(directive).toContain('There is no disclosure');
  });

  it('triggers the single opening immediately on acknowledgment without waiting for caller transcription', () => {
    const { mutable, sent, session } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    const rule = sent[0];
    mutable.handleMessage(JSON.stringify({ type: 'session.instructions.appended', client_event_id: rule.event_id }));
    expect(sent.map((event) => event.type)).toEqual(['session.instructions.append', 'session.commentary.append']);
    expect(sent[0].content).toContain('"Hi.');
    session.appendPcmuBase64('actual-caller-hello');
    expect(sent.at(-1)).toEqual({ type: 'session.input_audio.append', audio: 'actual-caller-hello' });
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.instructions.appended', client_event_id: rule.event_id }));
    expect(sent.filter((event) => event.type === 'session.instructions.append')).toHaveLength(1);
    expect(sent.filter((event) => event.type === 'session.commentary.append')).toHaveLength(1);
  });

  it('does not replay the greeting after early audio, late acknowledgment or a mid-call hello', () => {
    vi.useFakeTimers();
    try {
      const { mutable, sent } = makeSession();
      mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: speechAudio }));
      mutable.handleMessage(JSON.stringify({ type: 'session.instructions.appended', client_event_id: sent[0].event_id }));
      mutable.handleMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello?' }));
      vi.advanceTimersByTime(5_000);
      expect(sent.filter((event) => event.type === 'session.instructions.append')).toHaveLength(1);
      expect(sent.some((event) => event.type === 'session.commentary.append')).toBe(false);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('retries the opener once without ever replacing the live caller stream with silence', () => {
    vi.useFakeTimers();
    try {
      const { session, mutable, sent, queued } = makeSession();
      session.appendPcmuBase64('before');
      mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
      expect(sent.at(-1)).toEqual({ type: 'session.input_audio.append', audio: 'before' });
      mutable.handleMessage(
        JSON.stringify({
          type: 'session.instructions.appended',
          client_event_id: sent[0]?.event_id
        })
      );

      vi.advanceTimersByTime(1_500);
      expect(sent.filter((payload) => payload.type === 'session.commentary.append')).toHaveLength(2);
      expect(queued).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_500);
      expect(queued).toHaveBeenCalledOnce();

      session.confirmStartupEnvelopePlayback();
      expect(sent.filter((payload) => payload.type === 'session.input_audio.append')).toEqual([
        { type: 'session.input_audio.append', audio: 'before' }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an operator control when opening audio is queued even if the Twilio mark never returns', () => {
    const { session, mutable, sent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    session.injectInstruction('Yes, that works.', 'yes');
    expect(sent.some((payload) => String(payload.content ?? '').includes('Yes, that works.'))).toBe(false);

    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.done' }));

    expect(sent.some((payload) => String(payload.content ?? '').includes('Yes, that works.'))).toBe(true);
    expect(sent.filter((payload) => payload.type === 'session.commentary.append').at(-1)?.content)
      .toContain('callee-facing answer');
  });

  it('uses the post-audio idle boundary when Live emits no output-done event', () => {
    vi.useFakeTimers();
    try {
      const { mutable, sent, queued } = makeSession();
      mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
      mutable.handleMessage(
        JSON.stringify({
          type: 'session.instructions.appended',
          client_event_id: sent[0]?.event_id
        })
      );
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));

      vi.advanceTimersByTime(1_499);
      expect(queued).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(queued).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not postpone the opening boundary when audio chunks stream continuously', () => {
    vi.useFakeTimers();
    try {
      const { mutable, queued } = makeSession();
      mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'chunk-1' }));
      vi.advanceTimersByTime(500);
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'chunk-2' }));
      vi.advanceTimersByTime(500);
      mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'chunk-3' }));

      vi.advanceTimersByTime(499);
      expect(queued).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(queued).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases queued controls as soon as the callee responds after opening audio', () => {
    const { session, mutable, sent } = makeSession();
    mutable.handleMessage(JSON.stringify({ type: 'session.started' }));
    session.injectInstruction('Yes, that works.', 'yes');
    mutable.handleMessage(JSON.stringify({ type: 'session.output_audio.delta', delta: 'opening-audio' }));
    expect(sent.some((payload) => String(payload.content ?? '').includes('Yes, that works.'))).toBe(false);

    mutable.handleMessage(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello?' }));

    expect(sent.some((payload) => String(payload.content ?? '').includes('Yes, that works.'))).toBe(true);
  });
});


describe('supervisor data injection',()=>{
  it('keeps source facts out of system instructions and does not speak quiet context',()=>{
    const f=makeSession();f.mutable.handleMessage(JSON.stringify({type:'session.started'}));f.sent.length=0;
    expect(f.session.appendSupervisorResult({id:'1',kind:'context',text:'CRM procedure volume: 67'})).toBe(true);
    expect(f.sent.map(e=>e.type)).toEqual(['session.thinking.append']);f.session.close();
  });
  it('keeps action reference private and submits the exact proposal text for read-back',()=>{
    const f=makeSession();f.mutable.handleMessage(JSON.stringify({type:'session.started'}));f.sent.length=0;
    f.session.appendSupervisorResult({id:'2',kind:'proposal',actionId:'private-id',text:'Send an email to test@example.com. Subject: Test. Content: Hello.'});
    expect(f.sent.map(e=>e.type)).toEqual(['session.thinking.append','session.commentary.append']);
    expect(f.sent[1].content).not.toContain('private-id');expect(f.sent[1].content).toContain('Content: Hello.');f.session.close();
  });
  it('does not truncate a long proposal into partial approval',()=>{
    const f=makeSession();f.mutable.handleMessage(JSON.stringify({type:'session.started'}));f.sent.length=0;
    f.session.appendSupervisorResult({id:'3',kind:'proposal',actionId:'id',text:'Long proposal '.repeat(500)});
    expect(f.sent.every(e=>e.type==='session.thinking.append')).toBe(true);f.session.close();
  });
});
