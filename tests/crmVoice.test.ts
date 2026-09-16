import { describe, expect, it, vi } from 'vitest';
import twilio from 'twilio';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { completeTwilioCall } from '../src/twilio/client.js';
import { buildGptLiveSessionStart } from '../src/openai/gptLiveVoiceSession.js';
import { CrmJournal, CrmVoiceController, CRM_STORE_URL, crmStartSchema, canonicalCrmStartJson, crmInterviewInstructions, signature, signedRequestValid, validTwilioStreamSignature, type Store } from '../src/crmVoice.js';

vi.mock('../src/twilio/client.js', () => ({ completeTwilioCall: vi.fn(async () => {}) }));
const secret = 'synthetic-test-only-secret-0123456789';
const request = crmStartSchema.parse({ sessionId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'test-call-intent', to: '+15555550123', missionPrompt: 'Discuss last week and next week.', reportPeriod: 'weekly' });
function config() {
  return { ...getConfig(), CRM_VOICE_STORE_URL: CRM_STORE_URL, CRM_VOICE_WEBHOOK_SECRET: secret,
    CRM_VOICE_ENABLED: true, DRY_RUN_CALLS: false, OPENAI_API_KEY: 'synthetic',
    TWILIO_ACCOUNT_SID: 'synthetic', TWILIO_AUTH_TOKEN: 'synthetic', TWILIO_PHONE_NUMBER: '+15555550000', PUBLIC_BASE_URL: 'https://bridge.example' };
}

describe('CRM scoped authentication', () => {
  const timestamp = '1789443000'; const now = Number(timestamp) * 1000;
  const body = JSON.stringify({ sessionId: request.sessionId }); const path = '/crm/voice/status';
  const signed = signature(secret, timestamp, 'POST', path, body);
  it('binds raw body, method, and route', () => {
    expect(signedRequestValid(secret, timestamp, signed, 'POST', path, body, now)).toBe(true);
    expect(signedRequestValid(secret, timestamp, signed, 'POST', '/crm/voice/start', body, now)).toBe(false);
    expect(signedRequestValid(secret, timestamp, signed, 'GET', path, body, now)).toBe(false);
    expect(signedRequestValid(secret, timestamp, signed, 'POST', path, body + ' ', now)).toBe(false);
  });
  it('rejects missing, malformed, stale, and future signatures', () => {
    for (const value of [undefined, '', 'x', '0'.repeat(64), [signed]]) expect(signedRequestValid(secret, timestamp, value, 'POST', path, body, now)).toBe(false);
    expect(signedRequestValid(secret, timestamp, signed, 'POST', path, body, now + 301000)).toBe(false);
    expect(signedRequestValid(secret, timestamp, signed, 'POST', path, body, now - 301000)).toBe(false);
    expect(signedRequestValid(undefined, timestamp, signed, 'POST', path, body, now)).toBe(false);
  });
  it('checks Twilio handshakes against only the configured public host and exact stream', () => {
    const path = '/crm/voice/stream/' + request.sessionId;
    const signed = twilio.getExpectedTwilioSignature('synthetic', 'https://bridge.example' + path, {});
    expect(validTwilioStreamSignature(config(), path, signed)).toBe(true);
    expect(validTwilioStreamSignature(config(), path + 'other', signed)).toBe(false);
    expect(validTwilioStreamSignature({ ...config(), PUBLIC_BASE_URL: 'https://other.example' }, path, signed)).toBe(false);
    expect(validTwilioStreamSignature({ ...config(), TWILIO_AUTH_TOKEN: undefined }, path, signed)).toBe(false);
    expect(validTwilioStreamSignature(config(), path, '')).toBe(false);
  });
});

describe('HTTP boundary', () => {
  it('hangs up without starting audio when the started event cannot be saved', async () => {
    const sid = 'CA' + 'a'.repeat(32);
    const dial = vi.fn(async () => sid);
    const store: Store = async body => {
      if (body.action === 'claim') return { claimed: true };
      throw new Error('synthetic database projection failure');
    };
    const controller = new CrmVoiceController(config(), { store, dial });
    const server = http.createServer((req, res) => { void controller.handle(req, res, new URL(req.url!, 'http://localhost')); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const path = '/crm/voice/twiml?sessionId=' + request.sessionId;
    const form = { CallSid: sid, AnsweredBy: 'human' };
    try {
      const start = controller.start(request);
      // Race the answered callback against the pending journal acknowledgement.
      await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1));
      const response = await fetch(`http://127.0.0.1:${address.port}` + path, {
        method: 'POST', body: new URLSearchParams(form), headers: {
          'x-twilio-signature': twilio.getExpectedTwilioSignature('synthetic', 'https://bridge.example' + path, form),
        },
      });
      const xml = await response.text();
      expect(xml).toContain('<Hangup/>');
      expect(xml).not.toContain('<Stream');
      expect(await start).toMatchObject({ startState: 'uncertain', callSid: sid });
      expect(completeTwilioCall).toHaveBeenCalledWith(expect.anything(), sid);
      expect(dial).toHaveBeenCalledTimes(1);
      expect(controller.readiness().activeCalls).toBe(0);
    } finally { await controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('requires scoped signatures and exposes truthful readiness without private configuration', async () => {
    const controller = new CrmVoiceController({ ...config(), CRM_VOICE_ENABLED: false }, { store: async () => ({ accepted: true }) });
    const server = http.createServer((req, res) => { void controller.handle(req, res, new URL(req.url!, 'http://localhost')); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(base + '/crm/voice/health', { method: 'POST', body: '{}' })).status).toBe(401);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const path = '/crm/voice/health';
      const response = await fetch(base + path, { method: 'POST', body: '{}', headers: {
        'x-nwe-timestamp': timestamp, 'x-nwe-signature': signature(secret, timestamp, 'POST', path, '{}') } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ configured: true, ready: false, enabled: false, storeReachable: true });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain('synthetic');
      expect((await fetch(base + path)).status).toBe(405);
    } finally { await controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe('durable claim before dial', () => {
  it('accepts the CRM protocol-1 review hash after Zod has reordered the request', async () => {
    // Fixture follows the deployed CRM canonicalStartJson, independently of bridge schema order.
    const wire = '{"sessionId":"11111111-1111-4111-8111-111111111111","idempotencyKey":"test-call-intent","to":"+15555550123","targetName":"Alex","missionPrompt":"Review the brochure.","reportPeriod":"custom","language":"English","maxCallDurationSeconds":900,"reviewContext":{"reviewId":"22222222-2222-4222-8222-222222222222","documentId":"33333333-3333-4333-8333-333333333333","participantTelegramId":"1234"}}';
    const parsed = crmStartSchema.parse(JSON.parse(wire));
    expect(JSON.stringify(parsed)).not.toBe(wire); // Reproduces the production failure.
    expect(canonicalCrmStartJson(parsed)).toBe(wire);
    const expectedHash = createHash('sha256').update(wire).digest('hex');
    const store: Store = vi.fn(async body => {
      if (body.action === 'review_context') return { reviewContext: { ...parsed.reviewContext,
        title: 'Brochure', questions: [], constraints: '', briefing: '', pages: [] } };
      if (body.action === 'claim') {
        if (body.requestHash !== expectedHash) throw new Error('request_hash_mismatch');
        return { claimed: true };
      }
      return { accepted: true };
    });
    const dial = vi.fn(async () => 'CA' + 'a'.repeat(32));
    const controller = new CrmVoiceController(config(), { store, dial });
    expect((await controller.start(parsed)).startState).toBe('confirmed');
    expect(dial).toHaveBeenCalledTimes(1);
    await controller.close();
    const changed = { ...parsed, reviewContext: { ...parsed.reviewContext!, participantTelegramId: '9999' } };
    expect(createHash('sha256').update(canonicalCrmStartJson(changed)).digest('hex')).not.toBe(expectedHash);
  });
  it('keeps the non-review wire format and omits an empty target name like the CRM', () => {
    expect(canonicalCrmStartJson(request)).toBe(JSON.stringify(request));
    expect(canonicalCrmStartJson({ ...request, targetName: '' })).toBe(canonicalCrmStartJson(request));
  });
  it('blocks a review call before claim/dial when canonical document context does not match', async () => {
    const reference = { reviewId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333', participantTelegramId: '1234' };
    const reviewRequest = crmStartSchema.parse({ ...request, reportPeriod: 'custom', reviewContext: reference });
    const store: Store = vi.fn(async () => ({ reviewContext: { ...reference, participantTelegramId: '9999',
      title: 'Review', questions: [], constraints: '', briefing: '', pages: [] } }));
    const dial = vi.fn();
    const controller = new CrmVoiceController(config(), {store, dial});
    await expect(controller.start(reviewRequest)).rejects.toThrow('review_context_mismatch');
    expect(store).toHaveBeenCalledTimes(1);
    expect(dial).not.toHaveBeenCalled();
    await controller.close();
  });
  it('concurrent retries and a new worker only dial once with a shared durable claim', async () => {
    let claimed = false;
    const store: Store = vi.fn(async body => {
      if (body.action === 'claim') {
        if (!claimed) { claimed = true; return { claimed: true }; }
        return { claimed: false, session: { sessionId: request.sessionId, idempotencyKey: request.idempotencyKey,
          callSid: null, startState: 'pending', status: 'pending', transcriptFinal: false, finalSeq: null, lastSeq: 0 } };
      }
      return { accepted: true };
    });
    const dial = vi.fn(async () => 'CA' + 'a'.repeat(32));
    const first = new CrmVoiceController(config(), { store, dial });
    const second = new CrmVoiceController(config(), { store, dial });
    const results = await Promise.all([first.start(request), first.start(request), second.start(request)]);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(2);
    expect(results.filter(result => result.duplicate).every(result => result.startState === 'uncertain')).toBe(true);
    await first.close(); await second.close();
  });
  it('does not dial when durable claim cannot be confirmed', async () => {
    const dial = vi.fn(); const store: Store = async () => { throw new Error('offline'); };
    const controller = new CrmVoiceController(config(), { store, dial });
    await expect(controller.start(request)).rejects.toThrow(); expect(dial).not.toHaveBeenCalled(); await controller.close();
  });
  it('returns uncertainty after an ambiguous Twilio timeout without retrying', async () => {
    const store: Store = async body => body.action === 'claim' ? { claimed: true } : { accepted: true };
    const dial = vi.fn(async () => { throw new Error('timeout after acceptance'); });
    const controller = new CrmVoiceController(config(), { store, dial });
    expect((await controller.start(request)).startState).toBe('uncertain');
    expect(dial).toHaveBeenCalledTimes(1); await controller.close();
  });
  it('fails closed while disabled or dry-run rather than making a mock success', async () => {
    const dial = vi.fn();
    for (const overrides of [{ CRM_VOICE_ENABLED: false }, { DRY_RUN_CALLS: true }, { CRM_VOICE_STORE_URL: 'https://attacker.example' }]) {
      const controller = new CrmVoiceController({ ...config(), ...overrides }, { dial });
      expect(controller.readiness().ready).toBe(false);
      await expect(controller.start(request)).rejects.toThrow('not_ready'); await controller.close();
    }
    expect(dial).not.toHaveBeenCalled();
  });
});

describe('transcript journal', () => {
  it('retries identical events and only finalizes after all transcript acknowledgements', async () => {
    const received: any[] = []; let first = true;
    const store: Store = async body => { received.push(structuredClone(body)); if (first) { first = false; throw new Error('ack lost'); } return { accepted: true }; };
    const journal = new CrmJournal(request.sessionId, store, async () => {});
    journal.append('started', { callSid: 'synthetic' });
    journal.append('transcript', { speaker: 'remote', delta: 'Exact fragment ' });
    journal.append('transcript', { speaker: 'remote', delta: 'continued.' });
    expect(await journal.finish('completed', true, true)).toBe(true);
    expect(received[0]).toEqual(received[1]);
    expect(received.slice(1).map(body => body.events[0].seq)).toEqual([1, 2, 3, 4]);
    expect(received.at(-1).events[0].data).toEqual({ status: 'completed', finalSeq: 3, transcriptFinal: true, sessionClosed: true });
    expect(received[2].events[0].data.delta).toBe('Exact fragment ');
  });
  it('never writes a complete terminal after a permanent persistence gap', async () => {
    const store = vi.fn(async () => { throw new Error('offline'); });
    const journal = new CrmJournal(request.sessionId, store, async () => {});
    journal.append('transcript', { speaker: 'remote', delta: 'not saved' });
    expect(await journal.finish('completed', true)).toBe(false);
    expect(store).toHaveBeenCalledTimes(4);
    expect(store.mock.calls.every(([body]: any) => body.events[0].type === 'transcript')).toBe(true);
  });
  it('notifies the call once after permanent failure and never skips the lost event', async () => {
    const store = vi.fn(async () => { throw new Error('offline'); });
    const unavailable = vi.fn();
    const journal = new CrmJournal(request.sessionId, store, async () => {}, unavailable);
    journal.append('started', { callSid: 'synthetic' });
    journal.append('transcript', { speaker: 'remote', delta: 'must not silently continue' });
    expect(await journal.flush()).toBe(false);
    expect(await journal.finish('completed', true, true)).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(4);
    expect(store.mock.calls.every(([body]: any) => body.events[0].seq === 1)).toBe(true);
  });
  it('preserves incomplete outcomes explicitly', async () => {
    const events: any[] = []; const store: Store = async body => { events.push(body); return { accepted: true }; };
    const journal = new CrmJournal(request.sessionId, store);
    await journal.finish('voicemail', false);
    expect(events[0].events[0].data.transcriptFinal).toBe(false);
  });
  it('cannot declare a final transcript without an explicit protocol close acknowledgement', async () => {
    const events: any[] = []; const store: Store = async body => { events.push(body); return { accepted: true }; };
    const journal = new CrmJournal(request.sessionId, store);
    await journal.finish('completed', true);
    expect(events[0].events[0].data).toMatchObject({ transcriptFinal: false, sessionClosed: false });
  });
});

describe('separate reporting mission', () => {
  it('gives the voice and delegated backend the bound review briefing before the first question', () => {
    const reference = { reviewId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333', participantTelegramId: '1234' };
    const policy = crmInterviewInstructions({ ...request, reportPeriod: 'custom', reviewContext: reference },
      { ...reference, title:'Sample brochure', questions:['Is page 2 clear?'], constraints:'Keep the approved product wording.',
        briefing:'Page 2 compares two layouts.', pages:[] });
    const session: any = buildGptLiveSessionStart({ liveModel:'gpt-live-1', backendModel:'gpt-5.6-luna',
      instructions:policy, conversationInstructions:policy, voice:'cedar' });
    for (const instructions of [session.instructions, session.delegation.responses.instructions]) {
      expect(instructions).toContain('Is page 2 clear?');
      expect(instructions).toContain('Keep the approved product wording.');
      expect(instructions).toContain('Page 2 compares two layouts.');
      expect(instructions).toContain('untrusted evidence');
      expect(instructions).toContain('I’ll prepare the report for Alex');
      expect(instructions).toContain('Do not read back the recommendations');
      expect(instructions).not.toContain('End with prioritized recommendations and ask for corrections');
    }
  });
  it('uses GPT-Live full-duplex protocol with a reporting policy and shared backend context', () => {
    const policy = crmInterviewInstructions(request);
    const session: any = buildGptLiveSessionStart({ liveModel: 'gpt-live-1', backendModel: 'gpt-5.6-luna',
      instructions: policy, conversationInstructions: policy, voice: 'cedar' });
    expect(session.instructions).toBe(policy);
    expect(session.delegation.responses.instructions).toBe(policy);
    expect(session.audio.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
    expect(policy).toContain('Repeated institutions are allowed');
    expect(policy).not.toContain('wait for operator direction');
    const legacy: any = buildGptLiveSessionStart({ liveModel: 'gpt-live-1', backendModel: 'gpt-5.6-luna', instructions: 'Legacy mission', voice: 'cedar' });
    expect(legacy.instructions).toContain('You are Bridge');
  });
  it('rejects arbitrary callbacks, engines, and overlong calls on the scoped endpoint', () => {
    for (const extra of [{ callbackUrl: 'https://attacker.example' }, { agentEngine: 'realtime' }, { maxCallDurationSeconds: 1801 }]) {
      expect(crmStartSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it('keeps general outbound missions separate from staff reporting questions', () => {
    const policy = crmInterviewInstructions({ ...request, reportPeriod: 'custom', missionPrompt: 'Confirm office hours.' });
    expect(policy).toContain('Confirm office hours.');
    expect(policy).not.toContain('Three check-ins');
    expect(policy).not.toContain('plans for the next period');
  });
});
