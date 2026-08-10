import { describe, expect, it, vi } from 'vitest';
import {
  detectReservationQuestion,
  fillerTextForLanguage,
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

  it('uses non-substantive filler after remote speech stops without suppressing owner translation', async () => {
    vi.useFakeTimers();
    const spoken: Array<{ text: string; phase: string }> = [];
    const events: string[] = [];
    try {
      const controller = new PredictiveReservationController({
        userLanguage: 'English',
        remoteLanguage: 'Spanish',
        speakToRemote: async (text, phase) => {
          spoken.push({ text, phase });
          return 3;
        },
        emitEvent: (event) => events.push(event.event)
      });

      controller.handleRemoteTranslationDelta('For how many people is the reservation?');
      controller.handleRemoteAudioActivity(true);
      expect(controller.shouldSuppressOwnerTranslation()).toBe(false);
      expect(spoken).toEqual([]);

      await vi.advanceTimersByTimeAsync(900);

      expect(spoken).toHaveLength(1);
      expect(spoken[0]?.phase).toBe('prefix');
      expect([
        'Sí...',
        'Ah, ok...',
        'Un momento...',
        'A ver...',
        'Mmm, déjeme ver...',
        'Sí, deme un segundo...',
        'Ok, un segundo...'
      ]).toContain(spoken[0]?.text);
      expect(events).toContain('turn_started');
      expect(events).toContain('prefix_audio_started');
      expect(events).not.toContain('slot_resolved');
      expect(events).not.toContain('completion_audio_started');
      expect(controller.diagnostics()).toMatchObject({
        predictiveMode: 'restaurant_reservation_v1',
        predictiveResolvedSlots: {},
        predictiveSuppressedOwnerAudioChunks: 0,
        predictivePrefixAudioChunks: 3,
        predictiveCompletionAudioChunks: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps filler generic for supported remote languages', () => {
    expect(['Sí...', 'Ah, ok...', 'Un momento...', 'A ver...', 'Mmm, déjeme ver...', 'Sí, deme un segundo...', 'Ok, un segundo...']).toContain(
      fillerTextForLanguage('Spanish')
    );
    expect(["Oui...", "D'accord...", "Un instant...", "Je regarde...", "Oui, une seconde..."]).toContain(fillerTextForLanguage('French'));
    expect(fillerTextForLanguage('Spanish', 'Can you hear me?')).toMatch(/escucho|aquí estoy|segundo/);
    expect(fillerTextForLanguage('Spanish', '', 'Sí...')).not.toBe('Sí...');
  });

  it('reports unsupported user languages without activating turns', () => {
    const events: string[] = [];
    const controller = new PredictiveReservationController({
      userLanguage: 'French',
      remoteLanguage: 'Spanish',
      speakToRemote: async () => 0,
      emitEvent: (event) => events.push(event.event)
    });

    controller.handleRemoteTranslationDelta('For how many people is the reservation?');
    controller.handleRemoteAudioActivity(true);

    expect(events).toEqual(['unsupported_language']);
    expect(controller.shouldSuppressOwnerTranslation()).toBe(false);
    expect(controller.diagnostics()).toMatchObject({
      predictiveActiveTurn: false,
      predictivePendingSlot: null
    });
  });
});
