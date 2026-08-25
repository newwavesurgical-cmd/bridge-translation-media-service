export function normalizeDialPhoneNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Phone number is required');
  }

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new Error('Phone number must be a valid international number');
    }
    return `+${digits}`;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  throw new Error('Phone number must include country code or be a 10-digit US number');
}
