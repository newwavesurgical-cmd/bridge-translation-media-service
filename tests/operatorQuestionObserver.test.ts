import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import {
  observeOperatorQuestion,
  parseOperatorQuestionObservation
} from '../src/openai/operatorQuestionObserver.js';

const config = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_GPT_LIVE_BACKEND_MODEL: 'gpt-5.6-luna',
  OPENAI_SAFETY_IDENTIFIER: 'test-user'
} as AppConfig;

describe('operator question observer', () => {
  it('supplies durable operator answers and approved schedule even when recent turns contain no scheduling facts', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.input);
      expect(input.approved_schedule).toEqual({ day: 'Wednesday', time: '4:00PM' });
      expect(input.resolved_operator_answers).toEqual([
        { question: 'Which day can you come?', reply: 'relay_value: Wednesday' },
        { question: 'What time can you come?', reply: 'relay_value: 4 PM' }
      ]);
      expect(body.instructions).toContain('Repeating, reminding, or confirming an already-approved detail');
      expect(body.instructions).toContain('A changed day/time, new appointment, added condition');
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        requires_operator: false, kind: 'question', operator_question_en: '', operator_question_es: '',
        confidence: 0.99, reason: 'Recap of the existing approved meeting.'
      }) }), { status: 200 });
    });
    const result = await observeOperatorQuestion(config, {
      missionContext: 'Arrange a viewing.', currentRemoteUtterance: 'What date and time did we agree?',
      recentTurns: [{ speaker: 'remote', text: 'The paint is in good shape.' }],
      approvedSchedule: { day: 'Wednesday', time: '4:00PM' },
      resolvedOperatorAnswers: [
        { question: 'Which day can you come?', reply: 'relay_value: Wednesday' },
        { question: 'What time can you come?', reply: 'relay_value: 4 PM' }
      ]
    }, fetchMock as typeof fetch);
    expect(result?.requiresOperator).toBe(false);
  });

  it('accepts a complete bilingual operator question', () => {
    expect(
      parseOperatorQuestionObservation(
        JSON.stringify({
          requires_operator: true,
          kind: 'commitment',
          operator_question_en: 'The caller proposed Wednesday at 12:00 PM. Does that work for you?',
          operator_question_es: 'La persona propuso el miércoles a las 12:00 p. m. ¿Le conviene?',
          confidence: 0.96,
          reason: 'Specific appointment time needs approval.'
        })
      )
    ).toMatchObject({
      requiresOperator: true,
      kind: 'commitment',
      confidence: 0.96
    });
  });

  it('rejects a low-confidence blocking observation', () => {
    expect(
      parseOperatorQuestionObservation(
        JSON.stringify({
          requires_operator: true,
          kind: 'question',
          operator_question_en: 'What should the agent say?',
          operator_question_es: '¿Qué debe decir el agente?',
          confidence: 0.4,
          reason: 'uncertain'
        })
      )
    ).toBeNull();
  });

  it('uses structured Responses output without storing the observation', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.store).toBe(false);
      expect(body.model).toBe('gpt-5.6-luna');
      expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    requires_operator: true,
                    kind: 'commitment',
                    operator_question_en: 'The caller offered 12:00 PM. Does that time work for you?',
                    operator_question_es: 'La persona ofreció las 12:00 p. m. ¿Le conviene esa hora?',
                    confidence: 0.94,
                    reason: 'The time is not approved in the mission.'
                  })
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await observeOperatorQuestion(
      config,
      {
        missionContext: 'Arrange a meeting but do not choose a time.',
        currentRemoteUtterance: 'How about twelve?',
        recentTurns: [
          { speaker: 'agent', text: 'What time would work?' },
          { speaker: 'remote', text: 'How about twelve?' }
        ],
        deterministicClassification: {
          kind: 'commitment',
          blocking: true,
          reason: 'Scheduling commitment.'
        }
      },
      fetchMock as typeof fetch
    );

    expect(result?.questionEn).toContain('12:00 PM');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed to the deterministic path when the service is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    await expect(
      observeOperatorQuestion(
        config,
        {
          missionContext: 'Schedule a visit.',
          currentRemoteUtterance: 'Would Thursday work?',
          recentTurns: []
        },
        fetchMock as typeof fetch
      )
    ).resolves.toBeNull();
  });
});
