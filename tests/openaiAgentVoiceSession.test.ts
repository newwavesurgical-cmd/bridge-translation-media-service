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

function makeLiveSession(instructions = 'Mission instructions', spokenPurpose?: string) {
  const sent: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  const startupDiagnostics: unknown[] = [];
  const audioDeltas: string[] = [];
  const agentTranscriptDeltas: string[] = [];
  const speechStarted = vi.fn();
  const startupEnvelopeQueued = vi.fn();
  const session = new OpenAiAgentVoiceSession({
    config,
    instructions,
    firstUtterance: "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.",
    ...(spokenPurpose ? { spokenPurpose } : {}),
    voice: 'marin',
    onAudioDelta: (delta) => audioDeltas.push(delta),
    onRemoteTranscriptDelta: () => undefined,
    onAgentTranscriptDelta: (delta) => agentTranscriptDeltas.push(delta),
    onUserSpeechStarted: speechStarted,
    onStartupEnvelopeQueued: startupEnvelopeQueued,
    onStartupDiagnostics: (diagnostics) => startupDiagnostics.push(diagnostics),
    onStatus: () => undefined,
    onError: (error) => errors.push(error)
  });
  const mutable = session as unknown as {
    ws: { readyState: number; send: (payload: string) => void };
    statusValue: string;
    responseActive: boolean;
    firstUtteranceArmed: boolean;
    firstUtteranceDelivered: boolean;
    firstUtteranceTranscript: string;
    startupEnvelopePlaybackConfirmed: boolean;
    handleMessage: (message: string) => void;
  };
  mutable.ws = {
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
  };
  mutable.statusValue = 'live';
  return {
    session,
    mutable,
    sent,
    errors,
    startupDiagnostics,
    audioDeltas,
    agentTranscriptDeltas,
    speechStarted,
    startupEnvelopeQueued
  };
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

  it('keeps VAD non-interrupting while it continues into the prepared purpose', () => {
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
              create_response: false,
              interrupt_response: true
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

  it('releases buffered recipient audio and barge-in only after Twilio confirms the entire opener played', () => {
    const purpose = 'I am calling because I would like to schedule a landscaping estimate with Alberto.';
    const {
      session,
      mutable,
      sent,
      startupDiagnostics,
      speechStarted,
      startupEnvelopeQueued
    } = makeLiveSession('Language lock: speak only in English.', purpose);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    session.appendPcmuBase64('early-hello');
    mutable.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    expect(speechStarted).not.toHaveBeenCalled();

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'purpose-audio' }));
    mutable.handleMessage(
      JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: purpose })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(startupEnvelopeQueued).toHaveBeenCalledTimes(1);
    expect(startupDiagnostics.at(-1)).toMatchObject({
      startupEnvelopeQueued: true,
      startupEnvelopePlaybackConfirmed: false,
      bufferedStartupAudio: 1
    });
    expect(sent.some((payload) => payload.type === 'input_audio_buffer.append')).toBe(false);

    session.confirmStartupEnvelopePlayback();

    expect(sent.at(-2)).toMatchObject({
      type: 'session.update',
      session: { audio: { input: { turn_detection: { create_response: true, interrupt_response: true } } } }
    });
    expect(sent.at(-1)).toEqual({ type: 'input_audio_buffer.append', audio: 'early-hello' });
    expect(startupDiagnostics.at(-1)).toMatchObject({
      startupEnvelopePlaybackConfirmed: true,
      bufferedStartupAudio: 0
    });

    mutable.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    expect(speechStarted).toHaveBeenCalledTimes(1);
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

  it('uses the exact prepared English purpose even when the wrapper contains medical examples', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Policy example: if a patient needs a doctor appointment after surgery, use known medical facts.',
      'Mission:',
      'Confirm whether order 4471 shipped and request the tracking number.'
    ].join('\n');
    const purpose = "I'm calling to check whether order 4471 shipped.";
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions, purpose);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const opener = String((sent[1].response as { instructions?: string }).instructions);
    expect(opener).toContain(`Say exactly this sentence and nothing else:\n${purpose}`);
    expect(opener).not.toMatch(/doctor|appointment|surgery/i);

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'wrong-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: 'Because I would like to make an appointment with the doctor.'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    const retry = String((sent[2].response as { instructions?: string }).instructions);
    expect(retry).toContain('differed from the prepared, language-locked purpose');
    expect(retry).toContain(purpose);

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'correct-audio' }));
    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: purpose }));
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['correct-audio']);
    expect(agentTranscriptDeltas).toEqual([purpose]);
  });

  it('uses the exact prepared Spanish purpose without translating or substituting a category', () => {
    const rawInstructions = [
      'Language lock: speak only in es-ES.',
      'Policy examples mention doctors, appointments, cars, reservations, orders, and utility bills.',
      'Mission:',
      'Confirmar si el pedido 4471 ya fue enviado y pedir el número de seguimiento.'
    ].join('\n');
    const purpose = 'Llamo para confirmar si el pedido 4471 ya fue enviado.';
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions, purpose);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const opener = String((sent[1].response as { instructions?: string }).instructions);
    expect(opener).toContain(`Say exactly this sentence and nothing else:\n${purpose}`);
    expect(opener).not.toContain('make an appointment');

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'audio-es' }));
    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: purpose }));
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['audio-es']);
    expect(agentTranscriptDeltas).toEqual([purpose]);
  });

  it('recovers the canonical prepared purpose from the prompt for older clients', () => {
    const purpose = "I'm calling about the piano you listed for sale.";
    const rawInstructions = [
      'Language lock: speak only in en-US.',
      'Medical policy examples mention a doctor, appointment, surgery, and hospital.',
      `SPOKEN PURPOSE (RESOLVED): the purpose you state is EXACTLY this English sentence: "${purpose}" — never the mission text in another language.`,
      'Mission:',
      'Ask whether the piano is still available and whether the price is negotiable.'
    ].join('\n');
    const { mutable, sent } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const opener = String((sent[1].response as { instructions?: string }).instructions);
    expect(opener).toContain(`Say exactly this sentence and nothing else:\n${purpose}`);
    expect(opener).not.toMatch(/doctor|appointment|surgery|hospital/i);
  });

  it('notifies the bridge when remote speech starts so queued phone audio can be cleared', () => {
    const { mutable, sent, speechStarted } = makeLiveSession();
    mutable.startupEnvelopePlaybackConfirmed = true;

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
    const { mutable, sent } = makeLiveSession(
      rawInstructions,
      'Because I would like to make an appointment with the doctor for my son as soon as possible.'
    );
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript = "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const instructions = String((sent[1].response as { instructions?: string }).instructions);
    expect(instructions).toContain('Say exactly this sentence and nothing else');
    expect(instructions).toContain('make an appointment with the doctor for my son as soon as possible');
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
    expect(openerInstructions).toContain('Clean mission opening brief');
    expect(openerInstructions).toContain('doctor Ramírez');

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

  it('does not let generic daughter examples override the prepared son purpose', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Remote callee/contact: oficina del doctor Ramírez.',
      'If the mission says the appointment is for my son, daughter, child, spouse, mother, father, patient, or another known relationship, answer with that known relationship.',
      'Mission:',
      'Objetivo: pedir una cita con la oficina del doctor Ramírez porque mi hijo tiene problemas después de cirugía y necesita verlo pronto.'
    ].join('\n');
    const preparedPurpose =
      'Because I would like to make an appointment with Dr. Ramirez for my son as soon as possible.';
    const { mutable, sent } = makeLiveSession(rawInstructions, preparedPurpose);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    const openerInstructions = String((sent[1].response as { instructions?: string }).instructions);
    expect(openerInstructions).toContain(preparedPurpose);
    expect(openerInstructions).not.toContain('for my daughter');
  });

  it('buffers and retries a mission opener that asks the callee to verify the call reason', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call about paperwork.'
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
        delta: 'Because I would like to discuss the paperwork. Could you help me with that?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual([
      'Because I would like to discuss the paperwork. Could you help me with that?'
    ]);
  });

  it('buffers and retries a no-space mission opener that asks about a client request', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call about paperwork.'
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
        delta: 'Because I would like to discuss the paperwork. Could you help me with that?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual([
      'Because I would like to discuss the paperwork. Could you help me with that?'
    ]);
  });

  it('buffers and retries a mission opener that invents a matter-on-file placeholder', () => {
    const rawInstructions = [
      'Language lock: speak only in en-US, unless the remote callee explicitly cannot understand.',
      'Mission:',
      'Call about paperwork.'
    ].join('\n');
    const { mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession(rawInstructions);
    mutable.firstUtteranceArmed = true;
    mutable.firstUtteranceTranscript =
      "I'm Not a telemarketer. I'm using a translator app since my English is limited. I'm calling.";

    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));
    expect(String((sent[1].response as { instructions?: string }).instructions)).toContain(
      'Never say vague file/case placeholders'
    );

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          'Because I would like to verify the reason recorded for this outreach, can we discuss it now?'
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
        delta: 'Because I would like to discuss the paperwork. Could you help me with that?'
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual(['Because I would like to discuss the paperwork. Could you help me with that?']);
  });

  it('buffers and retries operator interventions that leak private planning text', () => {
    const { session, mutable, sent, audioDeltas, agentTranscriptDeltas } = makeLiveSession();
    mutable.firstUtteranceDelivered = true;

    session.injectInstruction('No puedo el jueves, necesito hacerlo el viernes.');
    mutable.handleMessage(
      JSON.stringify({
        type: 'error',
        error: { message: 'Cancellation failed: no active response found' }
      })
    );

    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel', 'conversation.item.create', 'response.create']);
    expect(String((sent[2].response as { instructions?: string }).instructions)).toContain(
      'Never preface with private planning'
    );

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'bad-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta:
          "Got it, I'll respond with that scheduling constraint clearly so we can keep moving. I can't do Thursday. I need to do it on Friday."
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual([]);
    expect(agentTranscriptDeltas).toEqual([]);
    expect(sent.map((payload) => payload.type)).toEqual([
      'response.cancel',
      'conversation.item.create',
      'response.create',
      'conversation.item.create',
      'response.create'
    ]);
    expect(String((sent[4].response as { instructions?: string }).instructions)).toContain(
      'previous draft response included private planning'
    );

    mutable.handleMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: 'good-audio' }));
    mutable.handleMessage(
      JSON.stringify({
        type: 'response.output_audio_transcript.delta',
        delta: "I can't do Thursday. I need to do it on Friday."
      })
    );
    mutable.handleMessage(JSON.stringify({ type: 'response.done' }));

    expect(audioDeltas).toEqual(['good-audio']);
    expect(agentTranscriptDeltas).toEqual(["I can't do Thursday. I need to do it on Friday."]);
  });

  it('buffers early recipient audio until the complete startup envelope is confirmed played', () => {
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
      firstUtteranceDelivered: true,
      bufferedStartupAudio: 2,
      startupEnvelopePlaybackConfirmed: false
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
