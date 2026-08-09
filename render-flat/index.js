const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const twilio = require('twilio');
const WebSocket = require('ws');
const { z } = require('zod');

const config = {
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  twilioWssUrl: process.env.TRANSLATION_MEDIA_PUBLIC_WSS_URL,
  appWssUrl: process.env.APP_STREAM_PUBLIC_WSS_URL,
  openAiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-realtime-translate',
  safetyIdentifier: process.env.OPENAI_SAFETY_IDENTIFIER || 'bridge-phone-call-prototype',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
  sharedSecret: process.env.BRIDGE_MEDIA_SHARED_SECRET,
  apiKey: process.env.BRIDGE_MEDIA_API_KEY,
  dryRunCalls: String(process.env.DRY_RUN_CALLS ?? 'true').toLowerCase() === 'true'
};

const createCallSchema = z.object({
  to: z.string().min(7),
  userLanguage: z.string().min(2),
  remoteLanguage: z.string().min(2),
  announceTranslationAtStart: z.boolean().optional()
});

const calls = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function xml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/xml' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  return body.trim() ? JSON.parse(body) : {};
}

function authorized(req) {
  return !config.apiKey || req.headers.authorization === `Bearer ${config.apiKey}`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function sign(value) {
  if (!config.sharedSecret) throw new Error('BRIDGE_MEDIA_SHARED_SECRET is required');
  return crypto.createHmac('sha256', config.sharedSecret).update(value).digest('hex');
}

function verify(value, token) {
  const expected = sign(value);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

function appUrl(callId) {
  const base = config.appWssUrl || `ws://localhost:${config.port}/app/stream`;
  return `${base}/${encodeURIComponent(callId)}?token=${encodeURIComponent(sign(`app-stream:${callId}`))}`;
}

function diagnostics(call) {
  return {
    callId: call.callId,
    callSid: call.callSid,
    state: call.state,
    to: call.to.length <= 4 ? '****' : `${'*'.repeat(call.to.length - 4)}${call.to.slice(-4)}`,
    userLanguage: call.userLanguage,
    remoteLanguage: call.remoteLanguage,
    appConnected: Boolean(call.appWs),
    twilioConnected: Boolean(call.twilioWs),
    sessionA: call.ownerToRemote?.status || 'idle',
    sessionB: call.remoteToOwner?.status || 'idle',
    transcriptDeltaCount: call.transcriptCount || 0,
    lastActivityAt: call.lastActivityAt || null
  };
}

async function createTwilioCall(call) {
  if (config.dryRunCalls) return null;
  if (!config.publicBaseUrl || !config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    throw new Error('Twilio call origination is not configured');
  }
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const twimlUrl = new URL('/twiml/translated-call', config.publicBaseUrl);
  twimlUrl.searchParams.set('callId', call.callId);
  const created = await client.calls.create({
    to: call.to,
    from: config.twilioPhoneNumber,
    url: twimlUrl.toString(),
    statusCallback: new URL('/twilio/status', config.publicBaseUrl).toString(),
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST'
  });
  return created.sid;
}

function buildTwiml(call) {
  if (!config.twilioWssUrl) throw new Error('TRANSLATION_MEDIA_PUBLIC_WSS_URL is required');
  const response = new twilio.twiml.VoiceResponse();
  if (call.announceTranslationAtStart) {
    response.say({ language: twilioSayLanguage(call.remoteLanguage) }, 'Hello. This call is using live translation. Please speak normally.');
  }
  const stream = response.connect().stream({ url: config.twilioWssUrl });
  stream.parameter({ name: 'callId', value: call.callId });
  stream.parameter({ name: 'streamToken', value: sign(`twilio-stream:${call.callId}`) });
  stream.parameter({ name: 'userLanguage', value: call.userLanguage });
  stream.parameter({ name: 'remoteLanguage', value: call.remoteLanguage });
  return response.toString();
}

function twilioSayLanguage(language) {
  const map = { spanish: 'es-ES', es: 'es-ES', english: 'en-US', en: 'en-US', french: 'fr-FR', german: 'de-DE', italian: 'it-IT', portuguese: 'pt-BR', chinese: 'zh-CN', japanese: 'ja-JP', korean: 'ko-KR' };
  return map[String(language).toLowerCase()] || 'en-US';
}

class OpenAiTranslationSession {
  constructor({ targetLanguage, onAudio, onInputTranscript, onOutputTranscript, onError }) {
    this.targetLanguage = targetLanguage;
    this.onAudio = onAudio;
    this.onInputTranscript = onInputTranscript;
    this.onOutputTranscript = onOutputTranscript;
    this.onError = onError;
    this.status = 'idle';
    this.queue = [];
  }

  connect() {
    if (this.ws || this.status === 'connecting' || this.status === 'live') return;
    if (!config.openAiKey) {
      this.status = 'error';
      this.onError(new Error('OPENAI_API_KEY missing'));
      return;
    }
    this.status = 'connecting';
    this.ws = new WebSocket(`wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(config.openAiModel)}`, {
      headers: { Authorization: `Bearer ${config.openAiKey}`, 'OpenAI-Safety-Identifier': config.safetyIdentifier }
    });
    this.ws.on('open', () => {
      this.status = 'live';
      this.send({ type: 'session.update', session: { audio: { output: { language: this.targetLanguage } } } });
      for (const audio of this.queue.splice(0)) this.append(audio);
    });
    this.ws.on('message', (raw) => this.handle(raw.toString()));
    this.ws.on('close', () => { this.ws = undefined; this.status = this.status === 'closing' ? 'closed' : 'closed'; });
    this.ws.on('error', (err) => { this.status = 'error'; this.onError(err); });
  }

  append(base64Pcm16) {
    if (this.status === 'idle') this.connect();
    if (this.status !== 'live') {
      this.queue.push(base64Pcm16);
      return;
    }
    this.send({ type: 'session.input_audio_buffer.append', audio: base64Pcm16 });
  }

  close() {
    this.status = 'closing';
    this.send({ type: 'session.close' });
    this.ws?.close();
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  handle(raw) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === 'session.output_audio.delta' && event.delta) this.onAudio(event.delta);
    else if (event.type === 'session.input_transcript.delta' && event.delta) this.onInputTranscript(event.delta);
    else if (event.type === 'session.output_transcript.delta' && event.delta) this.onOutputTranscript(event.delta);
    else if (event.type === 'error') this.onError(new Error(event.error?.message || 'OpenAI realtime translation error'));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'bridge-translation-media-service',
        twilioConfigured: Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioPhoneNumber),
        openAiConfigured: Boolean(config.openAiKey),
        mediaRouterConfigured: Boolean(config.publicBaseUrl && config.twilioWssUrl && config.appWssUrl),
        dryRunCalls: config.dryRunCalls,
        activeCalls: Array.from(calls.values()).map(diagnostics)
      });
    }
    if (req.method === 'POST' && url.pathname === '/calls') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = createCallSchema.parse(await readJson(req));
      const call = { callId: makeId('call'), callSid: null, state: 'created', transcriptCount: 0, ...body };
      calls.set(call.callId, call);
      call.callSid = await createTwilioCall(call);
      call.state = config.dryRunCalls ? 'created' : 'calling';
      return json(res, 201, { callId: call.callId, callSid: call.callSid, status: config.dryRunCalls ? 'dry_run' : 'calling', appStreamUrl: appUrl(call.callId), diagnostics: diagnostics(call) });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/hangup')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const call = calls.get(url.pathname.split('/')[2]);
      if (call?.callSid && !config.dryRunCalls) await twilio(config.twilioAccountSid, config.twilioAuthToken).calls(call.callSid).update({ status: 'completed' });
      call?.appWs?.close();
      call?.twilioWs?.close();
      calls.delete(call?.callId);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/dtmf')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { ok: true, note: 'DTMF prototype endpoint active; media-tone DTMF is not guaranteed for all IVRs.' });
    }
    if (req.method === 'GET' && url.pathname === '/twiml/translated-call') {
      const call = calls.get(url.searchParams.get('callId') || '');
      if (!call) return xml(res, 404, '<Response><Reject /></Response>');
      return xml(res, 200, buildTwiml(call));
    }
    if (req.method === 'POST' && url.pathname === '/twilio/status') {
      await readBody(req);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'unknown error' });
  }
});

const appWss = new WebSocket.Server({ noServer: true });
const twilioWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/app/stream/')) {
    return appWss.handleUpgrade(req, socket, head, (ws) => {
      const callId = decodeURIComponent(url.pathname.replace('/app/stream/', ''));
      const token = url.searchParams.get('token') || '';
      const call = calls.get(callId);
      if (!call || !verify(`app-stream:${callId}`, token)) return ws.close();
      call.appWs = ws;
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'audio') ensureSessions(call).ownerToRemote.append(msg.audio);
        if (msg.type === 'hangup') ws.close();
      });
    });
  }
  if (url.pathname === '/twilio/stream') {
    return twilioWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.event === 'start') {
          const call = calls.get(msg.start?.customParameters?.callId);
          if (!call || !verify(`twilio-stream:${call.callId}`, msg.start?.customParameters?.streamToken || '')) return ws.close();
          call.twilioWs = ws;
          call.streamSid = msg.start.streamSid;
          call.state = 'live';
        }
      });
    });
  }
  socket.destroy();
});

function ensureSessions(call) {
  if (call.ownerToRemote && call.remoteToOwner) return call;
  call.ownerToRemote = new OpenAiTranslationSession({
    targetLanguage: call.remoteLanguage,
    onAudio: () => {},
    onInputTranscript: (delta) => sendTranscript(call, 'owner', 'source', delta),
    onOutputTranscript: (delta) => sendTranscript(call, 'owner', 'translation', delta),
    onError: (err) => sendApp(call, { type: 'error', message: err.message })
  });
  call.remoteToOwner = new OpenAiTranslationSession({
    targetLanguage: call.userLanguage,
    onAudio: (audio) => sendApp(call, { type: 'translated_audio', speaker: 'remote', encoding: 'pcm16', sampleRate: 24000, audio }),
    onInputTranscript: (delta) => sendTranscript(call, 'remote', 'source', delta),
    onOutputTranscript: (delta) => sendTranscript(call, 'remote', 'translation', delta),
    onError: (err) => sendApp(call, { type: 'error', message: err.message })
  });
  call.ownerToRemote.connect();
  call.remoteToOwner.connect();
  return call;
}

function sendTranscript(call, speaker, transcriptKind, delta) {
  call.transcriptCount = (call.transcriptCount || 0) + 1;
  sendApp(call, { type: 'transcript_delta', speaker, transcriptKind, delta });
}

function sendApp(call, message) {
  if (call.appWs?.readyState === WebSocket.OPEN) call.appWs.send(JSON.stringify(message));
}

server.listen(config.port, () => {
  console.log(`Bridge translation media service listening on :${config.port}`);
});
