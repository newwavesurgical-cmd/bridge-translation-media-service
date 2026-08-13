import crypto from 'node:crypto';

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export function signValue(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function verifySignedValue(secret: string, value: string, signature: string): boolean {
  const expected = signValue(secret, value);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function makeStreamToken(secret: string, callId: string): string {
  return signValue(secret, `twilio-stream:${callId}`);
}

export function verifyStreamToken(secret: string, callId: string, token: string): boolean {
  return verifySignedValue(secret, `twilio-stream:${callId}`, token);
}

export function makeAppToken(secret: string, callId: string): string {
  return signValue(secret, `app-stream:${callId}`);
}

export function verifyAppToken(secret: string, callId: string, token: string): boolean {
  return verifySignedValue(secret, `app-stream:${callId}`, token);
}

export function makeInPersonDisplayToken(secret: string, sessionId: string, view: string): string {
  return signValue(secret, `in-person-display:${sessionId}:${view}`);
}

export function verifyInPersonDisplayToken(secret: string, sessionId: string, view: string, token: string): boolean {
  return verifySignedValue(secret, `in-person-display:${sessionId}:${view}`, token);
}
