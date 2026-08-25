import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { OpenAiAgentVoiceSession, buildAgentSessionUpdate } from '../src/openai/agentVoiceSession.js';

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

afterEach(() => {
  vi.useRealTimers();
});

function makeLiveSession(instructions = 'Mission instructions') {
  const sent: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  const startupDiagnostics: unknown[] = [];
  const audioDeltas: string[] = [];
  const agentTranscriptDeltas: string[] = [];
  const speechStarted = vi.fn();
  const session = new OpenAiAgentVoiceSession({
    config,
    instructions,
    firstUtterance: "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.",
    voice: 'marin',
    onAudioDelta: (delta) => audioDeltas.push(delta),
    onRemoteTranscriptDelta: () => undefined,
    onAgentTranscriptDelta: (delta) => agentTranscriptDeltas.push(delta),
    onUserSpeechStarted: speechStarted,
    onStartupDiagnostics: (diagnostics) => startupDiagnostics.push(diagnostics),
    onStatus: () => undefined,
    onError: (error) => errors.push(error)
  });
  const mutable = session as unknown as {
    ws: { readyState: number; send: (payload: string) => void };
    statusValue: string;
    responseActive: boolean;
    firstUtteranceArmed: boolean;
    firstUtteranceTranscript: string;
    handleMessage: (message: string) => void;
  };
  mutable.ws = {
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
  };
  mutable.statusValue = 'live';
  return { session, mutable, sent, errors, startupDiagnostics, audioDeltas, agentTranscriptDeltas, speechStarted };
}

describe('OpenAI agent voice session startup gate', () => {
  it('disables VAD auto-response until the first utterance is explicitly delivered', () => {
    expect(buildAgentSessionUpdate('gpt-realtime-2.1', 'Mission instructions', 'marin')).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      output_modalities: ['audio'],
      instructions: 'Mission instructions',
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: { model: 'gpt-realtime-whisper' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.38,
            prefix_padding_ms: 300,
            silence_duration_ms: 300,
            create_response: false,
            interrupt_response: true
          }
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice: 'marin'
        }
      }
    });
  });

  it('probes cancellation before an operator intervention to avoid active-response races', () => {
    const { session, mutable, sent } = makeLiveSession();

    session.injectInstruction('chapel hill');

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel']);

    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: { message: 'Cancellation failed: no active response found' }
      })
    );

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'conversation.item.create', 'response.create']);
    expect(String((sent[1].item as { content?: Array<{ text?: string }> }).content?.[0]?.text)).toContain(
      'Private operator intervention source text to apply, not quote'
    );
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain(
      'language lock remains mandatory'
    );
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain(
      'intended as words to say now'
    );
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain(
      'supplies a fact for the active question'
    );
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain(
      'Never ask the remote callee to provide those caller-side facts'
    );
  });

  it('keeps the session alive when a stale cancel reports no active response', () => {
    const { session, mutable, sent, errors } = makeLiveSession();
    mutable.responseActive = true;

    session.injectInstruction('yes', 'yes');
    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel']);

    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: { message: 'Cancellation failed: no active response found' }
      })
    );

    expect(errors).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'conversation.item.create', 'response.create']);
  });

  it('does not add an unsolicited follow-up after an operator intervention if the callee stays silent', () => {
    vi.useFakeTimers();
    const { session, mutable, sent } = makeLiveSession();

    session.injectInstruction('yes', 'yes');
    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: { message: 'Cancellation failed: no active response found' }
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    vi.advanceTimersByTime(3200);

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'conversation.item.create', 'response.create']);
  });

  it('does not retake the call after an operator intervention when the callee responds first', () => {
    vi.useFakeTimers();
    const { session, mutable, sent } = makeLiveSession();

    session.injectInstruction('yes', 'yes');
    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: { message: 'Cancellation failed: no active response found' }
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    mutable.handleMessage(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Okay' }));
    vi.advanceTimersByTime(3200);

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'conversation.item.create', 'response.create']);
  });

  it('keeps the session alive and retries cancellation when a response create races an active response', () => {
    const { mutable, sent, errors } = makeLiveSession();

    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: {
          message:
            'Conversation already has an active response in progress: resp_test. Wait until the response is finished before creating a new one.'
        }
      })
    );

    expect(errors).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel']);
  });

  it('reenables VAD with a complete session update and continues into the mission after the first utterance', () => {
    const { mutable, sent } = makeLiveSession();
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad',
              threshold: 0.38,
              prefix_padding_ms: 300,
              silence_duration_ms: 300,
              create_response: true
            }
          }
        }
      }
    });
    expect(sent[1]).toMatchObject({
      type: 'response.create',
      response: {
        output_modalities: ['audio']
      }
    });
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('Mission instructions');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('Do not repeat it');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Ignore any repeated first-utterance, disclosure, or "same message" requirement'
    );
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('ask exactly one mission-specific question');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('Translate the purpose into the locked spoken language');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('Do not list multiple wants');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Do not start with "Hello", "am I speaking with", "is this", contact confirmation'
    );
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain('Never say a generic placeholder');
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Never ask app-assistant questions'
    );
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Do not repeat the purpose in a second sentence'
    );
  });

  it('retries the mission opener if Realtime still has an active response after the first utterance', () => {
    const { mutable, sent, errors } = makeLiveSession();
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create']);

    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: {
          message:
            'Conversation already has an active response in progress: resp_test. Wait until the response is finished before creating a new one.'
        }
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.cancelled' }));

    expect(errors).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual([
      'session.update',
      'response.create',
      'response.cancel',
      'response.create'
    ]);
    expect(String((sent[3].response as { instructions?: string }).instructions)).toContain('Do not repeat it');
    expect(String((sent[3].response as { instructions?: string }).instructions)).toContain(
      'ask exactly one mission-specific question'
    );
  });

  it('notifies the bridge when remote speech starts so queued phone audio can be cleared', () => {
    const { mutable, sent, speechStarted } = makeLiveSession();

    mutable.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));

    expect(speechStarted).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('does not pass raw startup scaffolding or Spanish source text into the mission opener prompt', () => {
    const rawInstructions = [
      'You are a live outbound phone-call voice agent.',
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'LANGUAGE LOCK: Speak only English unless the callee or operator asks.',
      '=== OPERATOR LANGUAGE CONTEXT (HARD) === The operator speaks Spanish; address only the callee, in the locked language. === END OPERATOR LANGUAGE CONTEXT ===',
      '=== FIRST UTTERANCE DISCLOSURE (HARD) === LITERAL FIRST UTTERANCE CONTRACT: your VERY FIRST spoken words are EXACTLY this text, verbatim, in English: "Hey there, just so you know, I am a real person but I am using an AI translator." PURPOSE-SECOND RULE: immediately after the exact text, in the SAME message, state the call purpose.',
      'Objetivo: pedir una cita urgente con el doctor que operó a su hijo.'
    ].join('\n');
    const { mutable, sent } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const instructions = String((sent[1].response as { instructions?: string }).instructions);
    expect(instructions).toContain('Clean mission opening brief');
    expect(instructions).toContain('make an appointment');
    expect(instructions).not.toContain('PURPOSE-SECOND RULE');
    expect(instructions).not.toContain('LITERAL FIRST UTTERANCE CONTRACT');
    expect(instructions).not.toContain('pedir una cita urgente');
  });

  it('buffers and retries an English mission opener that leaks Spanish source text', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Objetivo: pedir una cita urgente con el doctor que operó a su hijo.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'I am calling about pedir una cita urgente con el doctor.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create', 'response.create']);
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain('previous draft opener');

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'I am calling to request an urgent appointment for your child.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual(['I am calling to request an urgent appointment for your child.']);
  });

  it('buffers and retries a mission opener that uses vague alarm placeholder phrasing', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call the pediatric office to schedule an urgent appointment for my son after surgery.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'I need to bring something to your attention.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create', 'response.create']);
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain('previous draft opener');
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain('Never open with vague alarm');

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'I am calling to schedule an urgent appointment for my son.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual(['I am calling to schedule an urgent appointment for my son.']);
  });

  it('buffers and retries a mission opener that starts with contact confirmation and app-assistant phrasing', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Remote callee/contact: oficina del doctor Ramírez.',
      'Mission:',
      'Objetivo: pedir una cita con la oficina del doctor Ramírez porque mi hijo tiene problemas y necesita verlo pronto.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    const openerInstructions = String((sent[1].response as { instructions?: string }).instructions);
    expect(openerInstructions).toContain('make an appointment with Dr. Ramirez');
    expect(openerInstructions).toContain('child is having issues');

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          'Hello, am I speaking with oficina del doctor Ramírez? I am calling for a quick outreach call. What would you like to do today?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create', 'response.create']);

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          'Because I would like to make an appointment with Dr. Ramirez for my son. He is having issues and needs to be seen as soon as possible. Do you have anything available soon?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual([
      'Because I would like to make an appointment with Dr. Ramirez for my son. He is having issues and needs to be seen as soon as possible. Do you have anything available soon?'
    ]);
  });

  it('buffers and retries a mission opener that asks the callee to verify the call reason', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call the doctor to make an appointment.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Never ask the callee to identify or verify the reason for the call'
    );

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          'Because I need to verify the reason for this call, could you tell me if this is regarding a request from a client?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create', 'response.create']);

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'Because I would like to make an appointment with the doctor. Do you have anything available soon?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual([
      'Because I would like to make an appointment with the doctor. Do you have anything available soon?'
    ]);
  });

  it('buffers and retries a no-space mission opener that asks about a client request', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call the doctor to make an appointment for my son.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Never say you are calling for, handling, verifying, or doing anything for a client'
    );

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          'BecauseIwouldliketoverifythereasonforarequestonbehalfofaclient,couldyouconfirmthereasonfortherequest?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create', 'response.create']);

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'Because I would like to make an appointment with the doctor for my son.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual(['Because I would like to make an appointment with the doctor for my son.']);
  });

  it('discards audio received before the first utterance instead of replaying it into the mission opener', () => {
    const { session, mutable, sent, startupDiagnostics } = makeLiveSession();
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    session.appendPcmuBase64('pre-first-audio-1');
    session.appendPcmuBase64('pre-first-audio-2');
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(sent.map((payload) => payload.type)).toEqual(['session.update', 'response.create']);
    expect(sent.some((payload) => payload.type === 'input_audio_buffer.append')).toBe(false);
    expect(startupDiagnostics.at(-1)).toMatchObject({
      preArmedAudio: 2,
      firstUtteranceDelivered: true
    });
  });

  it('does not restart the first utterance when Spanish transcript chunks split inside a word', () => {
    const sent: Array<Record<string, unknown>> = [];
    const session = new OpenAiAgentVoiceSession({
      config,
      instructions: 'Mission instructions',
      firstUtterance: 'Hola, solo para que sepa: soy una persona real, pero estoy usando un traductor de IA.',
      voice: 'cedar',
      onAudioDelta: () => undefined,
      onRemoteTranscriptDelta: () => undefined,
      onAgentTranscriptDelta: () => undefined,
      onStatus: () => undefined,
      onError: () => undefined
    });
    const mutable = session as unknown as {
      ws: { readyState: number; send: (payload: string) => void };
      statusValue: string;
      firstUtteranceArmed: boolean;
      handleMessage: (message: string) => void;
    };
    mutable.ws = {
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
    };
    mutable.statusValue = 'live';
    mutable.firstUtteranceArmed = true;

    for (const delta of ['Hola', ', solo para que se', 'pa: soy una persona real, pero estoy usando un traductor de IA.']) {
      mutable.handleMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta }));
    }

    expect(sent).toEqual([]);
  });

  it('does not send unsupported output buffer clear events during first-utterance correction', () => {
    const { mutable, sent } = makeLiveSession();
    mutable.responseActive = true;
    mutable.firstUtteranceArmed = true;

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Wrong opener' }));

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'response.create']);
    expect(sent.some((payload) => payload.type === 'output_audio_buffer.clear')).toBe(false);
  });
});
