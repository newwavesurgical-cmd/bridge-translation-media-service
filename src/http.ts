import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { mediaRouterConfigured, openAiConfigured, twilioConfigured } from './config.js';
import { CallRegistry } from './callRegistry.js';
import { AgentCallRegistry, contextualMicroInterventions } from './agentCallRegistry.js';
import { InPersonRegistry, type InPersonDisplayView } from './inPersonRegistry.js';
import { AppToAppRegistry, type AppToAppParticipant } from './appToAppRegistry.js';
import { originateAgentCall, originateTranslatedCall } from './twilio/client.js';
import { buildAgentCallTwiMl, buildTranslatedCallTwiMl } from './twilio/twiml.js';
import { normalizeDialPhoneNumber } from './phone.js';

const createCallSchema = z.object({
  to: z.string().min(7).transform(normalizeDialPhoneNumber),
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
  clientSessionId: z.string().optional(),
  inputMode: z.enum(['dual_channel', 'single_mic_hold_to_speak', 'single_mic_auto']).optional(),
  languageGateMode: z.enum(['off', 'monitor', 'soft_suppress']).optional()
});

const createAppToAppSessionSchema = z.object({
  initiatorLanguage: z.string().min(2),
  receiverLanguage: z.string().min(2),
  clientSessionId: z.string().optional(),
  fillerBridgeEnabled: z.boolean().optional(),
  fillerVoiceGender: z.enum(['auto', 'male', 'female']).optional(),
  languageGateMode: z.enum(['off', 'monitor', 'soft_suppress']).optional(),
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

const createAgentCallSchema = z
  .object({
    to: z.string().min(7).optional(),
    phoneNumber: z.string().min(7).optional(),
    clientSessionId: z.string().optional(),
    targetName: z.string().max(200).optional(),
    callerName: z.string().max(200).optional(),
    missionPrompt: z.string().max(6000).optional(),
    mission: z.string().max(6000).optional(),
    systemPrompt: z.string().max(6000).optional(),
    prompt: z.string().max(6000).optional(),
    instructions: z.string().max(6000).optional(),
    agentPrompt: z.string().max(6000).optional(),
    thoroughPrompt: z.string().max(6000).optional(),
    thoroughMissionPrompt: z.string().max(6000).optional(),
    agentInstructions: z.string().max(6000).optional(),
    missionInstructions: z.string().max(6000).optional(),
    systemInstructions: z.string().max(6000).optional(),
    generatedPrompt: z.string().max(6000).optional(),
    goal: z.string().max(2000).optional(),
    callGoal: z.string().max(2000).optional(),
    languageLock: z.string().max(80).optional(),
    voice: z.string().max(40).optional(),
    firstUtterance: z.string().max(300).optional(),
    requireLiteralFirstUtterance: z.boolean().optional(),
    deferFirstResponseUntilSessionReady: z.boolean().optional(),
    machineDetection: z.literal('DetectMessageEnd').optional(),
    asyncAmd: z.literal(false).optional(),
    machineDetectionTimeout: z.coerce.number().int().min(3).max(59).optional(),
    maxCallDurationSeconds: z.coerce.number().int().positive().optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .passthrough()
  .transform((body) => ({
    to: normalizeDialPhoneNumber(body.to ?? body.phoneNumber ?? ''),
    clientSessionId: body.clientSessionId,
    targetName: body.targetName,
    callerName: body.callerName,
    missionPrompt: firstText(
      body.missionPrompt,
      body.mission,
      body.agentPrompt,
      body.prompt,
      body.instructions,
      body.thoroughMissionPrompt,
      body.thoroughPrompt,
      body.agentInstructions,
      body.missionInstructions,
      body.generatedPrompt,
      body.callGoal,
      body.goal
    ),
    systemPrompt: firstText(body.systemPrompt, body.systemInstructions),
    languageLock: body.languageLock,
    voice: body.voice,
    firstUtterance: body.firstUtterance,
    requireLiteralFirstUtterance: body.requireLiteralFirstUtterance,
    deferFirstResponseUntilSessionReady: body.deferFirstResponseUntilSessionReady,
    machineDetection: body.machineDetection,
    asyncAmd: body.asyncAmd,
    machineDetectionTimeout: body.machineDetectionTimeout,
    maxCallDurationSeconds: body.maxCallDurationSeconds,
    metadata: body.metadata
  }))
  .refine((body) => body.to.length >= 7, { message: 'to or phoneNumber is required' });

const agentControlSchema = z.object({
  control: z.enum(contextualMicroInterventions).optional(),
  text: z.string().max(2000).optional(),
  note: z.string().max(2000).optional()
});

const dtmfSchema = z.object({
  digit: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'])
});

const agentTakeoverSchema = z.object({
  userLanguage: z.string().min(2).max(80).optional(),
  remoteLanguage: z.string().min(2).max(80).optional()
});

function firstText(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.replace(/\s+/g, ' ').trim());
}

export function createBridgeMediaServer(config: AppConfig) {
  const registry = new CallRegistry(config);
  const agentCallRegistry = new AgentCallRegistry(config);
  const inPersonRegistry = new InPersonRegistry(config);
  const appToAppRegistry = new AppToAppRegistry(config);
  const appWss = new WebSocketServer({ noServer: true });
  const twilioWss = new WebSocketServer({ noServer: true });
  const agentCallTwilioWss = new WebSocketServer({ noServer: true });
  const agentCallAppWss = new WebSocketServer({ noServer: true });
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
          gitCommit: serviceGitCommit(),
          twilioConfigured: twilioConfigured(config),
          openAiConfigured: openAiConfigured(config),
          mediaRouterConfigured: mediaRouterConfigured(config),
          agentCallSupported: true,
          agentRealtimeVoiceBridgeSupported: true,
          directVoiceTakeoverSupported: true,
          monitorStreamSupported: false,
          dryRunCalls: config.DRY_RUN_CALLS,
          activeCalls: registry.listDiagnostics(),
          recentCalls: registry.listRecentDiagnostics(),
          activeAgentCalls: agentCallRegistry.listDiagnostics(),
          recentAgentCalls: agentCallRegistry.listRecentDiagnostics(),
          activeInPersonSessions: inPersonRegistry.listDiagnostics(),
          recentInPersonSessions: inPersonRegistry.listRecentDiagnostics(),
          activeAppToAppSessions: appToAppRegistry.listDiagnostics(),
          recentAppToAppSessions: appToAppRegistry.listRecentDiagnostics()
        });
      }

      if (req.method === 'GET' && url.pathname === '/agent-call/health') {
        return sendJson(res, 200, agentCallHealth(config, agentCallRegistry));
      }

      if (req.method === 'GET' && url.pathname === '/agent-call/capabilities') {
        return sendJson(res, 200, agentCallCapabilities(config, agentCallRegistry));
      }

      if (req.method === 'POST' && url.pathname === '/agent-call/start') {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = createAgentCallSchema.parse(await readJson(req));
        const session = agentCallRegistry.create(body);
        const callSid = await originateAgentCall(config, session);
        session.setCallSid(callSid);
        session.markCalling();
        return sendJson(res, 201, {
          sessionId: session.sessionId,
          callId: session.sessionId,
          callSid,
          status: config.DRY_RUN_CALLS ? 'dry_run' : 'calling',
          monitorStreamSupported: false,
          directVoiceTakeoverSupported: true,
          monitorStreamUrl: session.monitorStreamUrl(),
          takeoverAppStreamUrl: session.appStreamUrl(),
          diagnostics: session.diagnostics()
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/agent-call/')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.replace('/agent-call/', ''));
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 404, { error: 'agent call not found' });
        }
        return sendJson(res, 200, { ok: true, diagnostics: session.diagnostics() });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent-call/') && url.pathname.endsWith('/control')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 404, { error: 'agent call not found' });
        }
        const body = agentControlSchema.parse(await readJson(req));
        const control = session.receiveControl(body);
        return sendJson(res, 200, { ok: true, control, diagnostics: session.diagnostics() });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent-call/') && url.pathname.endsWith('/takeover/start')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 404, { error: 'agent call not found' });
        }
        const body = agentTakeoverSchema.parse(await readJson(req));
        const takeover = session.startTakeover(body);
        return sendJson(res, 200, { ok: true, takeover, diagnostics: session.diagnostics() });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent-call/') && url.pathname.endsWith('/takeover/end')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 200, { ok: true, alreadyEnded: true });
        }
        session.stopTakeover();
        return sendJson(res, 200, { ok: true, diagnostics: session.diagnostics() });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent-call/') && url.pathname.endsWith('/dtmf')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 404, { error: 'agent call not found' });
        }
        const body = dtmfSchema.parse(await readJson(req));
        const dtmf = session.sendDtmf(body.digit);
        return sendJson(res, 200, { ok: true, dtmf, diagnostics: session.diagnostics() });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent-call/') && url.pathname.endsWith('/end')) {
        if (!authorized(config, req)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendJson(res, 200, { ok: true, alreadyEnded: true });
        }
        await session.end('requested');
        return sendJson(res, 200, { ok: true });
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
          displayStreams: session.displayStreams(),
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
        const body = dtmfSchema.parse(await readJson(req));
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

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/twiml/agent-call') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const session = agentCallRegistry.get(sessionId);
        if (!session) {
          return sendXml(res, 404, '<Response><Reject /></Response>');
        }
        session.applyTwilioMetadata({
          answeredBy: url.searchParams.get('AnsweredBy'),
          forwardedFrom: url.searchParams.get('ForwardedFrom'),
          callStatus: url.searchParams.get('CallStatus')
        });
        const xml = buildAgentCallTwiMl({ config, sessionId });
        return sendXml(res, 200, xml);
      }

      if (req.method === 'POST' && url.pathname === '/twilio/status') {
        const form = new URLSearchParams(await readBody(req));
        const sessionId = url.searchParams.get('sessionId');
        const callSid = form.get('CallSid');
        const session =
          (sessionId ? agentCallRegistry.get(sessionId) : undefined) ??
          (callSid ? agentCallRegistry.getByCallSid(callSid) : undefined);
        session?.applyTwilioMetadata({
          answeredBy: form.get('AnsweredBy'),
          forwardedFrom: form.get('ForwardedFrom'),
          callStatus: form.get('CallStatus')
        });
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

    if (url.pathname.startsWith('/agent-call/app/stream/')) {
      agentCallAppWss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = decodeURIComponent(url.pathname.replace('/agent-call/app/stream/', ''));
        const token = url.searchParams.get('token') ?? '';
        const session = agentCallRegistry.get(sessionId);
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

    if (url.pathname.startsWith('/in-person/display/')) {
      inPersonWss.handleUpgrade(req, socket, head, (ws) => {
        const parts = url.pathname.split('/').filter(Boolean);
        const sessionId = decodeURIComponent(parts[2] ?? '');
        const view = parts[3] as InPersonDisplayView | undefined;
        const token = url.searchParams.get('token') ?? '';
        const session = inPersonRegistry.get(sessionId);
        if (!session || (view !== 'owner' && view !== 'partner') || !session.verifyDisplayToken(view, token)) {
          ws.close();
          return;
        }
        session.bindDisplay(view, ws);
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

    if (url.pathname === '/agent-call/twilio/stream') {
      agentCallTwilioWss.handleUpgrade(req, socket, head, (ws) => {
        const preStartHandler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
          let parsedSessionId: string | undefined;
          try {
            const message = JSON.parse(raw.toString()) as {
              event?: string;
              start?: { customParameters?: Record<string, string> };
            };
            parsedSessionId = message.start?.customParameters?.sessionId;
          } catch {
            ws.close();
            return;
          }
          if (!parsedSessionId) {
            return;
          }
          const session = agentCallRegistry.get(parsedSessionId);
          if (!session) {
            ws.close();
            return;
          }
          if (session.handleTwilioPreStart(ws, raw.toString())) {
            ws.off('message', preStartHandler);
          }
        };
        ws.on('message', preStartHandler);
      });
      return;
    }

    socket.destroy();
  });

  return { server, registry, agentCallRegistry, inPersonRegistry, appToAppRegistry };
}

function agentCallHealth(config: AppConfig, agentCallRegistry: AgentCallRegistry): Record<string, unknown> {
  return {
    ok: true,
    service: 'bridge-translation-media-service',
    gitCommit: serviceGitCommit(),
    agentCallSupported: true,
    agentRealtimeVoiceBridgeSupported: true,
    monitorStreamSupported: false,
    twilioConfigured: twilioConfigured(config),
    openAiConfigured: openAiConfigured(config),
    mediaRouterConfigured: mediaRouterConfigured(config),
    dryRunCalls: config.DRY_RUN_CALLS,
    activeAgentCalls: agentCallRegistry.listDiagnostics(),
    recentAgentCalls: agentCallRegistry.listRecentDiagnostics()
  };
}

function serviceGitCommit(): string | null {
  return process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? process.env.COMMIT_SHA ?? null;
}

function agentCallCapabilities(config: AppConfig, agentCallRegistry: AgentCallRegistry): Record<string, unknown> {
  return {
    ...agentCallHealth(config, agentCallRegistry),
    realtimeModel: config.OPENAI_AGENT_MODEL,
    defaultVoice: 'marin',
    maxCallDurationSecondsDefault: 1800,
    languageLockSupported: true,
    directVoiceTakeoverSupported: true,
    ivrMenuDetectionSupported: true,
    ivrOptionDisplaySupported: true,
    ivrDtmfFallbackSupported: true,
    contextualMicroInterventionControls: contextualMicroInterventions,
    endpoints: {
      start: 'POST /agent-call/start',
      status: 'GET /agent-call/:sessionId',
      control: 'POST /agent-call/:sessionId/control',
      end: 'POST /agent-call/:sessionId/end',
      twiml: 'GET|POST /twiml/agent-call',
      twilioMediaStream: 'WS /agent-call/twilio/stream'
      ,
      takeoverStart: 'POST /agent-call/:sessionId/takeover/start',
      takeoverEnd: 'POST /agent-call/:sessionId/takeover/end',
      takeoverAppStream: 'WS /agent-call/app/stream/:sessionId',
      dtmf: 'POST /agent-call/:sessionId/dtmf'
    }
  };
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
