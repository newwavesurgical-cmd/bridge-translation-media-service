import { describe, expect, it } from 'vitest';
import { normalizeDialPhoneNumber } from '../src/phone.js';

describe('normalizeDialPhoneNumber', () => {
  it('keeps international numbers with plus sign and strips formatting', () => {
    expect(normalizeDialPhoneNumber('+1 (305) 804-9516')).toBe('+13058049516');
    expect(normalizeDialPhoneNumber('+52 55 1234 5678')).toBe('+525512345678');
  });

  it('normalizes 10-digit US numbers to E.164', () => {
    expect(normalizeDialPhoneNumber('305-804-9516')).toBe('+13058049516');
    expect(normalizeDialPhoneNumber('(919) 555-0208')).toBe('+19195550208');
  });

  it('normalizes 11-digit US numbers that already include country code 1', () => {
    expect(normalizeDialPhoneNumber('1 305 804 9516')).toBe('+13058049516');
  });

  it('rejects ambiguous numbers', () => {
    expect(() => normalizeDialPhoneNumber('555-0208')).toThrow('Phone number must include country code');
    expect(() => normalizeDialPhoneNumber('+123')).toThrow('valid international number');
  });
});
