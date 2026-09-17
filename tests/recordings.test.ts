import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config.js';
import { createRecordingAccess, currentRecordingInstructions, recordingState } from '../src/twilio/recordings.js';
import { originateTranslatedCall, originateAgentCall } from '../src/twilio/client.js';
import { crmDialOptions, crmStartSchema } from '../src/crmVoice.js';
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock('twilio', () => ({ default: Object.assign(vi.fn(() => ({ calls: Object.assign(() => ({ recordings: { list: mocks.list } }), { create: mocks.create }) })), { twiml: {} }) }));
const account = 'AC' + '1'.repeat(32), callSid = 'CA' + '2'.repeat(32), sid = 'RE' + '3'.repeat(32);
const config = { ...getConfig(), TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'test-only', TWILIO_PHONE_NUMBER: '+15555550100',
  PUBLIC_BASE_URL: 'https://bridge.example', DRY_RUN_CALLS: false };
const row = { accountSid: account, callSid, sid, status: 'completed', duration: '120', channels: 2, dateCreated: new Date('2026-09-17T00:00:00Z') };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('record every outbound phone path', () => {
  it('requests both speakers from answer for translated, standalone agent and CRM calls', async () => {
    mocks.create.mockResolvedValue({ sid: callSid });
    await originateTranslatedCall(config, { callId: 'call', data: { to: '+15555550200' } } as never);
    await originateAgentCall(config, { sessionId: 'agent', data: { to: '+15555550200', machineDetectionTimeout: 30 } } as never);
    for (const [options] of mocks.create.mock.calls) expect(options).toMatchObject({ record: true, recordingChannels: 'dual', recordingTrack: 'both' });
    const request = crmStartSchema.parse({ sessionId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'test', to: '+15555550200', missionPrompt: 'Test', reportPeriod: 'weekly' });
    expect(crmDialOptions(request, '+15555550100', 'https://bridge.example/twiml', 'https://bridge.example/status')).toMatchObject({ record: true, recordingChannels: 'dual', recordingTrack: 'both' });
  });
});
describe('provider recording access', () => {
  it('filters another call/account and exposes only safe metadata', async () => {
    mocks.list.mockResolvedValue([row, { ...row, callSid: 'CA' + '9'.repeat(32) }, { ...row, accountSid: 'AC' + '9'.repeat(32) }]);
    const result = await createRecordingAccess(config).list(callSid);
    expect(result).toEqual([{ sid, status: 'completed', durationSeconds: 120, channels: 2, dateCreated: '2026-09-17T00:00:00.000Z' }]);
    expect(JSON.stringify(result)).not.toContain('test-only');
  });
  it('rejects an unbound recording before fetching audio', async () => {
    mocks.list.mockResolvedValue([row]); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(createRecordingAccess(config).media(callSid, 'RE' + '9'.repeat(32), 'mp3')).rejects.toMatchObject({ statusCode: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns pending and unavailable honestly', async () => {
    mocks.list.mockResolvedValue([{ ...row, status: 'in-progress' }]);
    await expect(createRecordingAccess(config).media(callSid, sid, 'mp3')).rejects.toMatchObject({ statusCode: 409 });
    expect(recordingState([])).toBe('unavailable');
    expect(recordingState([{ status: 'in-progress' } as never])).toBe('processing');
    expect(recordingState([{ status: 'absent' } as never])).toBe('unavailable');
  });
  it('returns full binary from a fixed authenticated provider URL', async () => {
    mocks.list.mockResolvedValue([row]); const bytes = new Uint8Array([73, 68, 51, 0, 255]);
    const fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetcher);
    expect(await createRecordingAccess(config).media(callSid, sid, 'mp3')).toEqual(Buffer.from(bytes));
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${sid}.mp3?RequestedChannels=2`);
  });
  it('never treats provider errors as an empty successful recording', async () => {
    mocks.list.mockRejectedValue(new Error('provider down'));
    await expect(createRecordingAccess(config).list(callSid)).rejects.toThrow();
    await expect(createRecordingAccess({ ...config, TWILIO_AUTH_TOKEN: undefined }).list(callSid)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('removes obsolete retention instructions without changing review content', () => {
    const text = 'Tell them a transcript goes to Alex and call audio is not retained. Step 2A is optional. Call audio is not retained.';
    const updated = currentRecordingInstructions(text);
    expect(updated).not.toMatch(/not retained/); expect(updated).toContain('Step 2A is optional.');
  });
});
