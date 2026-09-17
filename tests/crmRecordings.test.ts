import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config.js';
import { CrmVoiceController, signature, type Store } from '../src/crmVoice.js';
import { RecordingError } from '../src/twilio/recordings.js';
const sessionId = '11111111-1111-4111-8111-111111111111', callSid = 'CA' + 'a'.repeat(32), recordingSid = 'RE' + 'b'.repeat(32);
const secret = 'recording-test-only';
async function fixture(run: (request: (path: string, body: unknown, authenticated?: boolean) => Promise<Response>, store: ReturnType<typeof vi.fn>, recordings: any) => Promise<void>) {
  const store = vi.fn(async () => ({ session: { sessionId, callSid, status: 'completed', transcriptFinal: true } }));
  const recordings = { list: vi.fn(async () => [{ sid: recordingSid, status: 'completed', durationSeconds: 10, channels: 2, dateCreated: null }]), media: vi.fn(async () => Buffer.from([1, 2, 255])) };
  const controller = new CrmVoiceController({ ...getConfig(), CRM_VOICE_WEBHOOK_SECRET: secret }, { store: store as unknown as Store, recordings });
  const server = http.createServer((req, res) => { void controller.handle(req, res, new URL(req.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try { await run(async (path, body, authenticated = true) => {
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: raw, headers: authenticated ? {
      'x-nwe-timestamp': timestamp, 'x-nwe-signature': signature(secret, timestamp, 'POST', path, raw) } : {} });
  }, store, recordings); } finally { await controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('signed persistent recording lookup', () => {
  it('rejects unauthenticated access before store or provider lookup', async () => fixture(async (request, store, recordings) => {
    expect((await request('/crm/voice/recordings', { sessionId }, false)).status).toBe(401);
    expect(store).not.toHaveBeenCalled(); expect(recordings.list).not.toHaveBeenCalled();
  }));
  it('uses only canonical persisted callSID, works without live in-memory session', async () => fixture(async (request, store, recordings) => {
    const response = await request('/crm/voice/recordings', { sessionId });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sessionId, status: 'available', provider: 'twilio' });
    expect(recordings.list).toHaveBeenCalledWith(callSid);
    expect((await request('/crm/voice/recordings', { sessionId, callSid: 'CA' + '9'.repeat(32) })).status).toBe(400);
    expect(recordings.list).toHaveBeenCalledTimes(1);
  }));
  it('serves protected complete binary and preserves provider error status', async () => fixture(async (request, store, recordings) => {
    const response = await request('/crm/voice/recording', { sessionId, recordingSid });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 255]));
    expect(recordings.media).toHaveBeenCalledWith(callSid, recordingSid, 'mp3');
    recordings.media.mockRejectedValue(new RecordingError(409, 'recording_not_ready'));
    expect((await request('/crm/voice/recording', { sessionId, recordingSid })).status).toBe(409);
    recordings.media.mockRejectedValue(new RecordingError(404, 'recording_not_found'));
    expect((await request('/crm/voice/recording', { sessionId, recordingSid })).status).toBe(404);
  }));
  it('rejects wrong session binding and distinguishes absent/provider-down', async () => fixture(async (request, store, recordings) => {
    recordings.list.mockResolvedValue([]);
    expect(await (await request('/crm/voice/recordings', { sessionId })).json()).toMatchObject({ status: 'unavailable', recordings: [] });
    recordings.list.mockRejectedValue(new Error('provider credentials must not leak'));
    const failed = await request('/crm/voice/recordings', { sessionId });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('credentials');
    store.mockResolvedValue({ session: { sessionId: '22222222-2222-4222-8222-222222222222', callSid, status: 'completed', transcriptFinal: true } });
    expect((await request('/crm/voice/recordings', { sessionId })).status).toBe(404);
  }));
});
