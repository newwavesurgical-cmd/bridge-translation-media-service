import { describe, expect, it } from 'vitest';
import { buildAgentSessionUpdate } from '../src/openai/agentVoiceSession.js';

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
            type: 'semantic_vad',
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
});
