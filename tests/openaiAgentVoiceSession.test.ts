import { describe, expect, it } from 'vitest';
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

function makeLiveSession() {
  const sent: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  const session = new OpenAiAgentVoiceSession({
    config,
    instructions: 'Mission instructions',
    firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
    voice: 'marin',
    onAudioDelta: () => undefined,
    onRemoteTranscriptDelta: () => undefined,
    onAgentTranscriptDelta: () => undefined,
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
  return { session, mutable, sent, errors };
}

describe('OpenAI agent voice session startup gate', () => {
  it('uses fast server VAD while disabling auto-response until the first utterance is delivered', () => {
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
            threshold: 0.45,
            prefix_padding_ms: 250,
            silence_duration_ms: 450,
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

  it('cancels active agent speech and emits barge-in when caller speech starts', () => {
    const sent: Array<Record<string, unknown>> = [];
    let bargeIns = 0;
    const session = new OpenAiAgentVoiceSession({
      config,
      instructions: 'Mission instructions',
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
      voice: 'marin',
      onAudioDelta: () => undefined,
      onBargeIn: () => {
        bargeIns += 1;
      },
      onRemoteTranscriptDelta: () => undefined,
      onAgentTranscriptDelta: () => undefined,
      onStatus: () => undefined,
      onError: () => undefined
    });
    const mutable = session as unknown as {
      ws: { readyState: number; send: (payload: string) => void };
      statusValue: string;
      firstUtteranceDelivered: boolean;
      responseActive: boolean;
      handleMessage: (message: string) => void;
    };
    mutable.ws = {
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
    };
    mutable.statusValue = 'live';
    mutable.firstUtteranceDelivered = true;
    mutable.responseActive = true;

    mutable.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));

    expect(bargeIns).toBe(1);
    expect(sent.map((payload) => payload.type)).toEqual(['response.cancel']);
  });

  it('cancels active agent speech from sustained caller audio even before speech_started arrives', () => {
    const sent: Array<Record<string, unknown>> = [];
    let bargeIns = 0;
    const session = new OpenAiAgentVoiceSession({
      config,
      instructions: 'Mission instructions',
      firstUtterance: "Hey there, just so you know, I am a real person but I'm using an AI translator.",
      voice: 'marin',
      onAudioDelta: () => undefined,
      onBargeIn: () => {
        bargeIns += 1;
      },
      onRemoteTranscriptDelta: () => undefined,
      onAgentTranscriptDelta: () => undefined,
      onStatus: () => undefined,
      onError: () => undefined
    });
    const mutable = session as unknown as {
      ws: { readyState: number; send: (payload: string) => void };
      statusValue: string;
      firstUtteranceDelivered: boolean;
      responseActive: boolean;
    };
    mutable.ws = {
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>)
    };
    mutable.statusValue = 'live';
    mutable.firstUtteranceDelivered = true;
    mutable.responseActive = true;

    for (let index = 0; index < 6; index += 1) {
      session.appendPcmuBase64('caller-audio');
    }

    expect(bargeIns).toBe(1);
    expect(sent.map((payload) => payload.type)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'response.cancel',
      'input_audio_buffer.append'
    ]);
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
    mutable.firstUtteranceTranscript = "Hey there, just so you know, I am a real person but I'm using an AI translator.";

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
              threshold: 0.45,
              prefix_padding_ms: 250,
              silence_duration_ms: 450,
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
