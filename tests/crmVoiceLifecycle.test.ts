import http from 'node:http';
import { once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config.js';
import { CrmVoiceController, CRM_STORE_URL, crmStartSchema, crmDialOptions, crmOpening } from '../src/crmVoice.js';

const fake = vi.hoisted(() => ({ sessions: [] as any[] }));
vi.mock('../src/openai/gptLiveVoiceSession.js', async importOriginal => ({
  ...await importOriginal<any>(),
  OpenAiGptLiveVoiceSession: class {
    inputs: string[] = [];
    constructor(readonly options: any) { fake.sessions.push(this); }
    connect() { this.options.onStatus('live'); }
    appendPcmuBase64(audio: string) { this.inputs.push(audio); }
    notifyPlaybackCleared() {}
    confirmPlaybackCheckpoint() {}
    close() { this.options.onSessionCloseConfirmed(); this.options.onStatus('closed'); }
  }
}));
vi.mock('../src/twilio/client.js', () => ({ completeTwilioCall: vi.fn(async () => {}) }));

async function fixture(reviewName?: string, callback = false) {
  const events: any[] = [];
  const callSid = 'CA' + 'a'.repeat(32);
  const request = crmStartSchema.parse({ sessionId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'synthetic-lifecycle', to: '+15555550123', missionPrompt: 'Collect reporting facts.', reportPeriod: reviewName || callback ? 'custom' : 'weekly',
    ...(reviewName ? { targetName: reviewName, reviewContext: { reviewId: '33333333-3333-4333-8333-333333333333',
      documentId: '44444444-4444-4444-8444-444444444444', participantTelegramId: '1234' } } : {}) });
  const config = { ...getConfig(), CRM_VOICE_WEBHOOK_SECRET: 'synthetic-credential-for-tests-only', CRM_VOICE_STORE_URL: CRM_STORE_URL,
    CRM_VOICE_ENABLED: true, OPENAI_API_KEY: 'synthetic', TWILIO_AUTH_TOKEN: 'synthetic', TWILIO_ACCOUNT_SID: 'synthetic',
    TWILIO_PHONE_NUMBER: '+15555550000', PUBLIC_BASE_URL: 'https://bridge.example', DRY_RUN_CALLS: false };
  const controller = new CrmVoiceController(config, {
    store: async body => {
      if (body.action === 'callback_capabilities') return {callbackCapabilities:{enabled:callback,protocolVersion:2}};
      if (body.action === 'callback_tool') return {toolResult:{ok:true,answer:'Authorized synthetic CRM answer',requestId:body.requestId}};
      if (body.action === 'review_context') return { reviewContext: { ...request.reviewContext,
        title: 'Sample brochure', questions: ['What wording should change?'], constraints: '', briefing: 'Two page brochure.', pages: [] } };
      if (body.action === 'claim') return { claimed: true };
      if (body.action === 'append') events.push(...body.events as any[]);
      return { accepted: true };
    }, dial: async () => callSid
  });
  const server = http.createServer((req, res) => { void controller.handle(req, res, new URL(req.url!, 'http://localhost')); });
  server.on('upgrade', (req, socket, head) => controller.upgrade(req, socket, head, new URL(req.url!, 'http://localhost')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  await controller.start(request);
  const connect = async () => {
    const path = '/crm/voice/stream/' + request.sessionId;
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: {
      'x-twilio-signature': twilio.getExpectedTwilioSignature('synthetic', config.PUBLIC_BASE_URL + path, {})
    } });
    const received: any[] = [];
    client.on('message', data => received.push(JSON.parse(data.toString())));
    await once(client, 'open');
    client.send(JSON.stringify({ event: 'start', start: { callSid, streamSid: 'MZsynthetic',
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
    await vi.waitFor(() => expect(fake.sessions).toHaveLength(1));
    return { client, received, live: fake.sessions[0] };
  };
  return { events, connect, request, port, config,
    close: async () => { await controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

beforeEach(() => { fake.sessions.length = 0; });
describe('CRM media lifecycle with synthetic Twilio and GPT-Live', () => {
  it('returns research through the same live session while accepting caller audio', async () => {
    const f = await fixture(undefined, true);
    try {
      const {client,live} = await f.connect();
      expect(live.options.voice).toBe('cedar');
      expect(live.options.backendTools.map((t:any)=>t.name)).toEqual([
        'search_callback_crm','research_callback_question','get_callback_task','save_callback_followup']);
      expect(live.options.instructions).toContain('saved task can finish after hang-up');
      expect(await live.options.executeBackendTool('search_callback_crm',{query:'clinic'},'call_syn'))
        .toMatchObject({ok:true,answer:'Authorized synthetic CRM answer',requestId:'call_syn'});
      client.send(JSON.stringify({event:'media',media:{payload:'AQID'}}));
      await vi.waitFor(()=>expect(live.inputs).toEqual(['AQID']));
      client.send(JSON.stringify({event:'stop'}));
      await vi.waitFor(()=>expect(f.events.at(-1)?.type).toBe('terminal'));
      expect(await live.options.executeBackendTool('search_callback_crm',{query:'clinic'},'call_late')).toMatchObject({ok:false});
    } finally {await f.close();}
  });
  it('connects a requested review without AMD and starts with the named, directed interview', async () => {
    const f = await fixture('Theo Example');
    try {
      const dial = crmDialOptions(f.request, '+15555550000', 'https://bridge.example/twiml', 'https://bridge.example/status');
      expect(dial).not.toHaveProperty('machineDetection');
      expect(dial).not.toHaveProperty('asyncAmd');
      expect(dial).not.toHaveProperty('machineDetectionTimeout');
      expect(dial.statusCallbackEvent).toEqual(['completed']);
      const path = '/crm/voice/twiml?sessionId=' + f.request.sessionId;
      const fields = { CallSid: 'CA' + 'a'.repeat(32) }; // Twilio omits AnsweredBy when AMD is disabled.
      const response = await fetch(`http://127.0.0.1:${f.port}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilio.getExpectedTwilioSignature('synthetic', f.config.PUBLIC_BASE_URL + path, fields) },
        body: new URLSearchParams(fields) });
      expect(response.status).toBe(200);
      const xml = await response.text();
      expect(xml).toContain('<Connect><Stream');
      expect(xml).not.toContain('<Hangup');
      const { client, live } = await f.connect();
      expect(live.options.firstUtterance).toBe("Hi Theo! I'm NWE's AI assistant.");
      expect(live.options.spokenPurpose).toContain('document Alex shared');
      for (const instructions of [live.options.instructions, live.options.conversationInstructions]) {
        expect(instructions).toContain('You drive the interview');
        expect(instructions).toContain('honor interruptions');
        expect(instructions).toContain('What wording should change?');
      }
      expect(crmOpening({ ...f.request, targetName: 'Sandy Example' }).firstUtterance).toBe("Hi Sandy! I'm NWE's AI assistant.");
      client.send(JSON.stringify({ event: 'stop' }));
      await vi.waitFor(() => expect(f.events.at(-1)?.type).toBe('terminal'));
    } finally { await f.close(); }
  });
  it('preserves detection for calls outside management document reviews', async () => {
    const f = await fixture();
    try {
      for (const reportPeriod of ['weekly', 'monthly', 'custom'] as const) {
        expect(crmDialOptions({ ...f.request, reportPeriod }, '+15555550000', 'https://bridge.example/twiml', 'https://bridge.example/status'))
          .toMatchObject({ machineDetection: 'DetectMessageEnd', asyncAmd: 'false', machineDetectionTimeout: 30 });
      }
    } finally { await f.close(); }
  });

  it('keeps input flowing during output, clears interrupted playback, and journals final speech before terminal', async () => {
    const f = await fixture();
    try {
      const { client, received, live } = await f.connect();
      live.options.onAudioDelta('////');
      client.send(JSON.stringify({ event: 'media', media: { payload: 'AQID' } }));
      await vi.waitFor(() => expect(live.inputs).toEqual(['AQID']));
      live.options.onUserSpeechStarted();
      live.options.onRemoteTranscriptDelta('I completed three visits. ');
      live.options.onAgentTranscriptDelta('What are your plans?');
      await vi.waitFor(() => expect(received.some(e => e.event === 'clear')).toBe(true));
      client.send(JSON.stringify({ event: 'stop' }));
      await vi.waitFor(() => expect(f.events.at(-1)?.type).toBe('terminal'));
      expect(f.events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
      expect(f.events.at(-1).data).toEqual({ status: 'completed', finalSeq: 3, transcriptFinal: true, sessionClosed: true });
      expect(f.events[1].data.delta).toBe('I completed three visits. ');
    } finally { await f.close(); }
  });
  it('retains a partial transcript but never finalizes an abruptly lost media stream', async () => {
    const f = await fixture();
    try {
      const { client, live } = await f.connect();
      live.options.onAudioDelta('////');
      live.options.onRemoteTranscriptDelta('Saved partial report.');
      client.terminate();
      await vi.waitFor(() => expect(f.events.at(-1)?.type).toBe('terminal'));
      expect(f.events.some(e => e.type === 'transcript')).toBe(true);
      expect(f.events.at(-1).data).toMatchObject({ status: 'stream_disconnected', transcriptFinal: false });
    } finally { await f.close(); }
  });
  it('hangs up on voicemail without opening GPT-Live or completing a report', async () => {
    const f = await fixture();
    try {
      const path = '/crm/voice/twiml?sessionId=' + f.request.sessionId;
      const fields = { CallSid: 'CA' + 'a'.repeat(32), AnsweredBy: 'machine_end_beep' };
      const response = await fetch(`http://127.0.0.1:${f.port}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilio.getExpectedTwilioSignature('synthetic', f.config.PUBLIC_BASE_URL + path, fields) },
        body: new URLSearchParams(fields) });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<Hangup/>');
      await vi.waitFor(() => expect(f.events.at(-1)?.type).toBe('terminal'));
      expect(f.events.at(-1).data).toMatchObject({ status: 'voicemail', transcriptFinal: false, sessionClosed: false });
      expect(fake.sessions).toHaveLength(0);
    } finally { await f.close(); }
  });
});
