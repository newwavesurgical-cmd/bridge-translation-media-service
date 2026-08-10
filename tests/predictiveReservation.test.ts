import { describe, expect, it } from 'vitest';
import {
  detectReservationQuestion,
  PredictiveReservationController,
  resolveSlotValue
} from '../src/predictive/reservationController.js';

describe('predictive reservation controller', () => {
  it('detects reservation slot questions from translated remote text', () => {
    expect(detectReservationQuestion('For how many people is the reservation?')).toMatchObject({
      slot: 'party_size',
      intent: 'reservation_party_size'
    });
    expect(detectReservationQuestion('What time would you like to come?')).toMatchObject({
      slot: 'time',
      intent: 'reservation_time'
    });
    expect(detectReservationQuestion('Can I get a phone number?')).toMatchObject({
      slot: 'phone_number',
      intent: 'reservation_phone_number'
    });
  });

  it('resolves supported slots without inventing missing values', () => {
    expect(resolveSlotValue('party_size', 'Seven, actually make that five.')).toMatchObject({
      value: '5',
      spokenCompletion: '5 personas.'
    });
    expect(resolveSlotValue('date', 'tomorrow night')).toMatchObject({
      value: 'mañana'
    });
    expect(resolveSlotValue('confirmation', 'yes that is correct')).toMatchObject({
      value: 'sí, está correcto'
    });
    expect(resolveSlotValue('party_size', 'I am not sure yet')).toBeNull();
  });

  it('starts a predictive turn and suppresses direct owner translation until the slot resolves', async () => {
    const spoken: Array<{ text: string; phase: string }> = [];
    const events: string[] = [];
    const controller = new PredictiveReservationController({
      userLanguage: 'English',
      remoteLanguage: 'Spanish',
      speakToRemote: async (text, phase) => {
        spoken.push({ text, phase });
        return phase === 'prefix' ? 3 : 2;
      },
      emitEvent: (event) => events.push(event.event)
    });

    controller.handleRemoteTranslationDelta('For how many people is the reservation?');
    expect(controller.shouldSuppressOwnerTranslation()).toBe(true);

    controller.handleOwnerSourceDelta('seven people');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spoken).toEqual([
      { text: 'Claro, puedo hacer la reservación para...', phase: 'prefix' },
      { text: '7 personas.', phase: 'completion' }
    ]);
    expect(events).toContain('turn_started');
    expect(events).toContain('slot_resolved');
    expect(events).toContain('completion_audio_started');
    expect(controller.shouldSuppressOwnerTranslation()).toBe(false);
    expect(controller.diagnostics()).toMatchObject({
      predictiveMode: 'restaurant_reservation_v1',
      predictiveResolvedSlots: { party_size: '7' },
      predictivePrefixAudioChunks: 3,
      predictiveCompletionAudioChunks: 2
    });
  });

  it('reports unsupported language pairs without activating turns', () => {
    const events: string[] = [];
    const controller = new PredictiveReservationController({
      userLanguage: 'English',
      remoteLanguage: 'French',
      speakToRemote: async () => 0,
      emitEvent: (event) => events.push(event.event)
    });

    controller.handleRemoteTranslationDelta('For how many people is the reservation?');

    expect(events).toEqual(['unsupported_language']);
    expect(controller.shouldSuppressOwnerTranslation()).toBe(false);
    expect(controller.diagnostics()).toMatchObject({
      predictiveActiveTurn: false,
      predictivePendingSlot: null
    });
  });
});
