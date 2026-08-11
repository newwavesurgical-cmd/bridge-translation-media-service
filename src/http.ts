import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { mediaRouterConfigured, openAiConfigured, twilioConfigured } from './config.js';
import { CallRegistry } from './callRegistry.js';
import { InPersonRegistry } from './inPersonRegistry.js';
import { AppToAppRegistry, type AppToAppParticipant } from './appToAppRegistry.js';
import { originateTranslatedCall } from './twilio/client.js';
import { buildTranslatedCallTwiMl } from './twilio/twiml.js';

const createCallSchema = z.object({
  to: z.string().min(7),
  userLanguage: z.string().min(2),
  remoteLanguage: z.string().min(2),
  announceTranslationAtStart: z.boolean().optional(),
  introMessageText: z.string().max(800).optional(),
  introDisclaimerText: z.string().max(800).optional(),
  predictiveMode: z.enum(['off', 'restaurant_reservation_v1']).optional(),
  fillerVoiceGender: z.enum(['auto', 'male', 'female']).optional(),
  clientCallId: z.string().optional()
});

const createInPersonSessionSchema = z.object({
  userLanguage: z.string().min(2),
  partnerLanguage: z.string().min(2),
  clientSessionId: z.string().optional()
});

const createAppToAppSessionSchema = z.object({
  initiatorLanguage: z.string().min(2),
  receiverLanguage: z.string().min(2),
  clientSessionId: z.string().optional(),
  fillerBridgeEnabled: z.boolean().optional(),
  fillerVoiceGender: z.enum(['auto', 'male', 'female']).optional(),
  predictiveMode: z.preprocess(
    (value) => {
      if (value === true) {
        return 'restaurant_reservation_v1';
      }
      if (value === false) {
        return 'off';
      }
      return value;
    },
    z.enum(['off', 'restaurant_reservation_v1']).optional()
  )
});

export function createBridgeMediaServer(config: AppConfig) {
  const registry = new CallRegistry(config);
  const inPersonRegistry = new InPersonRegistry(config);
  const appToAppRegistry = new AppToAppRegistry(config);
  const appWss = new WebSocketServer({ noServer: true });
  const twilioWss = new WebSocketServer({ noServer: true });
  const inPersonWss = new WebSocketServer({ noServer: true });
  const appToAppWss = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'OPTIONS') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'bridge-translation-media-service',
          twilioConfigured: twilioConfigured(config),
          openAiConfigured: openAiConfigured(config),
          mediaRouterConfigured: mediaRouterConfigured(config),
          dryRunCalls: config.DRY_RUN_CALLS,
          activeCalls: registry.listDiagnostics(),
          recentCalls: registry.listRecentDiagnostics(),
          activeInPersonSessions: inPersonRegistry.listDiagnostics(),
          recentInPersonSessions: inPersonRegistry.listRecentDiagnostics(),
          activeAppToAppSessions: appToAppRegistry.listDiagnostics(),
          recentAppToAppSessions: appToAppRegistry.listRecentDiagnostics()
        });
      }

      if (req.method === 'POST' && url.pathname === '/calls') {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = createCallSchema.parse(await readJson(req));
        const session = registry.create(body);
        const callSid = await originateTranslatedCall(config, session);
        session.setCallSid(callSid);
        session.data.state = config.DRY_RUN_CALLS ? 'created' : 'calling';
        return sendJson(res, 201, {
          callId: session.callId,
          callSid,
          status: config.DRY_RUN_CALLS ? 'dry_run' : 'calling',
          appStreamUrl: session.appStreamUrl(),
          diagnostics: session.diagnostics()
        });
      }

      if (req.method === 'POST' && url.pathname === '/in-person/sessions') {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = createInPersonSessionSchema.parse(await readJson(req));
        const session = inPersonRegistry.create(body);
        return sendJson(res, 201, {
          sessionId: session.sessionId,
          status: 'created',
          streamUrl: session.streamUrl(),
          diagnostics: session.diagnostics()
        });
      }

      if (req.method === 'POST' && url.pathname === '/app-to-app/sessions') {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = createAppToAppSessionSchema.parse(await readJson(req));
        const session = appToAppRegistry.create(body);
        return sendJson(res, 201, {
          sessionId: session.sessionId,
          status: 'created',
          initiatorStreamUrl: session.participantStreamUrl('initiator'),
          receiverStreamUrl: session.participantStreamUrl('receiver'),
          inviteCode: session.inviteCode,
          inviteUrlPath: `/j/${encodeURIComponent(session.inviteCode)}`,
          legacyInviteUrlPath: `/app-to-app?sessionId=${encodeURIComponent(session.sessionId)}&role=receiver`,
          diagnostics: session.diagnostics()
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/app-to-app/invites/')) {
        const inviteCode = decodeURIComponent(url.pathname.replace('/app-to-app/invites/', ''));
        const session = appToAppRegistry.getByInviteCode(inviteCode);
        if (!session) {
          return sendJson(res, 404, {
            ok: false,
            error: 'invite not found or expired'
          });
        }
        return sendJson(res, 200, {
          ok: true,
          ...session.receiverInvite()
        });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/calls/') && url.pathname.endsWith('/dtmf')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const callId = url.pathname.split('/')[2] ?? '';
        const session = registry.get(callId);
        if (!session) {
          return sendJson(res, 404, { error: 'call not found' });
        }
        const body = z.object({ digit: z.string().min(1).max(1) }).parse(await readJson(req));
        session.sendDtmf(body.digit);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/calls/') && url.pathname.endsWith('/hangup')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const callId = url.pathname.split('/')[2] ?? '';
        const session = registry.get(callId);
        if (!session) {
          return sendJson(res, 200, { ok: true, alreadyEnded: true });
        }
        await session.hangup();
        return sendJson(res, 200, { ok: true });
      }

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/twiml/translated-call') {
        const callId = url.searchParams.get('callId') ?? '';
        const session = registry.get(callId);
        if (!session) {
          return sendXml(res, 404, '<Response><Reject /></Response>');
        }
        const xml = buildTranslatedCallTwiMl({
          config,
          callId,
          userLanguage: session.data.userLanguage,
          remoteLanguage: session.data.remoteLanguage,
          announceTranslationAtStart: session.data.announceTranslationAtStart,
          introMessageText: session.data.introMessageText,
          introDisclaimerText: session.data.introDisclaimerText
        });
        return sendXml(res, 200, xml);
      }

      if (req.method === 'POST' && url.pathname === '/twilio/status') {
        await readBody(req);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return sendJson(res, 500, { error: message });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/app/stream/')) {
      appWss.handleUpgrade(req, socket, head, (ws) => {
        const callId = decodeURIComponent(url.pathname.replace('/app/stream/', ''));
        const token = url.searchParams.get('token') ?? '';
        const session = registry.get(callId);
        if (!session || !session.verifyAppToken(token)) {
          ws.close();
          return;
        }
        session.bindApp(ws);
      });
      return;
    }

    if (url.pathname.startsWith('/in-person/stream/')) {
      inPersonWss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = decodeURIComponent(url.pathname.replace('/in-person/stream/', ''));
        const token = url.searchParams.get('token') ?? '';
        const session = inPersonRegistry.get(sessionId);
        if (!session || !session.verifyAppToken(token)) {
          ws.close();
          return;
        }
        session.bindApp(ws);
      });
      return;
    }

    if (url.pathname.startsWith('/app-to-app/stream/')) {
      appToAppWss.handleUpgrade(req, socket, head, (ws) => {
        const parts = url.pathname.split('/').filter(Boolean);
        const sessionId = decodeURIComponent(parts[2] ?? '');
        const participant = parts[3] as AppToAppParticipant | undefined;
        const token = url.searchParams.get('token') ?? '';
        const session = appToAppRegistry.get(sessionId);
        if (
          !session ||
          (participant !== 'initiator' && participant !== 'receiver') ||
          !session.verifyParticipantToken(participant, token)
        ) {
          ws.close();
          return;
        }
        session.bindParticipant(participant, ws);
      });
      return;
    }

    if (url.pathname === '/twilio/stream') {
      twilioWss.handleUpgrade(req, socket, head, (ws) => {
        let bound = false;
        const preStartHandler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
          let parsedCallId: string | undefined;
          try {
            const message = JSON.parse(raw.toString()) as {
              event?: string;
              start?: { customParameters?: Record<string, string> };
            };
            parsedCallId = message.start?.customParameters?.callId;
          } catch {
            ws.close();
            return;
          }
          if (!parsedCallId) {
            return;
          }
          const session = registry.get(parsedCallId);
          if (!session) {
            ws.close();
            return;
          }
          bound = session.handleTwilioPreStart(ws, raw.toString());
          if (bound) {
            ws.off('message', preStartHandler);
          }
        };
        ws.on('message', preStartHandler);
      });
      return;
    }

    socket.destroy();
  });

  return { server, registry, inPersonRegistry, appToAppRegistry };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function sendXml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/xml' });
  res.end(body);
}

function authorized(config: AppConfig, req: http.IncomingMessage): boolean {
  if (!config.BRIDGE_MEDIA_API_KEY) {
    return true;
  }
  return req.headers.authorization === `Bearer ${config.BRIDGE_MEDIA_API_KEY}`;
}
