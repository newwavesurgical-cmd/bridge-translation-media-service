import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCallRegistry } from '../src/agentCallRegistry.js';
import type { AppConfig } from '../src/config.js';
import { createBridgeMediaServer } from '../src/http.js';

/**
 * Direct voice takeover must never engage on a call that is over.
 *
 * The Bridge app opens the operator's microphone only when this service
 * reports `active: true` (see `startVoiceTakeover` in the app repo). Before
 * this change `startTakeover` always answered `active: true`, so that
 * client-side guard could never fire.
 *
 * A cleanly ended call is disposed out of the registry, so the route already
 * 404s there. The reachable gap was `fail()`: it leaves the session in the
 * registry in state 'error', and a takeover on it used to succeed and hand
 * back an app stream URL. These tests pin the honest answer for both.
 */

const config: AppConfig = {
  PORT: 8787,
  PUBLIC_BASE_URL: 'https://bridge-media.example.com',
  TRANSLATION_MEDIA_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/twilio/stream',
  APP_STREAM_PUBLIC_WSS_URL: 'wss://bridge-media.example.com/app/stream',
  OPENAI_API_KEY: '',
  OPENAI_TRANSLATION_MODEL: 'gpt-realtime-translate',
  OPENAI_AGENT_MODEL: 'gpt-realtime-2.1',
  OPENAI_TTS_MODEL: 'gpt-4o-mini-tts',
  OPENAI_TTS_VOICE: 'cedar',
  OPENAI_FILLER_TTS_VOICE: 'onyx',
  OPENAI_FILLER_TTS_VOICE_MALE: 'onyx',
  OPENAI_FILLER_TTS_VOICE_FEMALE: 'nova',
  OPENAI_SAFETY_IDENTIFIER: 'test-user',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'auth',
  TWILIO_PHONE_NUMBER: '+15551234567',
  BRIDGE_MEDIA_SHARED_SECRET: 'test-secret-long-enough',
  BRIDGE_MEDIA_API_KEY: 'test-service-api-key-long-enough',
  DRY_RUN_CALLS: true
};

const servers: Array<ReturnType<typeof createBridgeMediaServer>['server']> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function fixture() {
  const bridge = createBridgeMediaServer(config);
  servers.push(bridge.server);
  await new Promise<void>((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const port = (bridge.server.address() as AddressInfo).port;
  return { bridge, baseUrl: `http://127.0.0.1:${port}` };
}

const headers = {
  Authorization: `Bearer ${config.BRIDGE_MEDIA_API_KEY}`,
  'Content-Type': 'application/json'
};

describe('direct voice takeover refuses finished calls', () => {
  it('an ended call reports active:false and hands back no app stream URL', async () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_ended',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });
    await session.end('requested');

    const takeover = session.startTakeover({ userLanguage: 'Spanish' });

    expect(takeover.active).toBe(false);
    expect(takeover).not.toHaveProperty('appStreamUrl');
    if (!takeover.active) {
      expect(takeover.state).toBe('ended');
      expect(takeover.reason).toBe('agent call is not active');
    }
    // The refusal must leave the record untouched — no takeover was started.
    expect(session.diagnostics()).toMatchObject({ takeoverActive: false });
  });

  it('a live call is still allowed to take over', () => {
    const session = new AgentCallRegistry(config).create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_allowed',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'Spanish'
    });

    const takeover = session.startTakeover({ userLanguage: 'English' });

    expect(takeover.active).toBe(true);
    if (takeover.active) {
      expect(takeover.appStreamUrl).toContain('/agent-call/app/stream/agent_takeover_allowed');
      // The call's own lock still wins over anything the client sends.
      expect(takeover.remoteLanguage).toBe('Spanish');
    }
  });

  it('POST /takeover/start answers 200 while live and 409 for a retained errored call', async () => {
    const { bridge, baseUrl } = await fixture();

    const live = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_http_live',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });
    const okResponse = await fetch(`${baseUrl}/agent-call/${live.sessionId}/takeover/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userLanguage: 'English' })
    });
    const okPayload = (await okResponse.json()) as Record<string, unknown>;
    expect(okResponse.status).toBe(200);
    expect(okPayload).toMatchObject({ ok: true, takeover: { active: true } });

    // A session that hit `fail()` stays in the registry in state 'error' — it
    // is never disposed — so this is the reachable case the guard exists for.
    const broken = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_http_error',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });
    broken.data.state = 'error';

    const conflict = await fetch(`${baseUrl}/agent-call/${broken.sessionId}/takeover/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userLanguage: 'English' })
    });
    const conflictPayload = (await conflict.json()) as Record<string, unknown>;
    expect(conflict.status).toBe(409);
    expect(conflictPayload).toMatchObject({
      ok: false,
      error: 'agent call is not active',
      takeover: { active: false, state: 'error' }
    });
    // No microphone destination may be handed back on the refusal path.
    expect(JSON.stringify(conflictPayload)).not.toContain('appStreamUrl');
  });

  it('an ended call is disposed, so the route 404s rather than handing back a stream', async () => {
    const { bridge, baseUrl } = await fixture();
    const dead = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_http_ended',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });
    await dead.end('requested');

    const response = await fetch(`${baseUrl}/agent-call/${dead.sessionId}/takeover/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userLanguage: 'English' })
    });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(JSON.stringify(payload)).not.toContain('appStreamUrl');
  });

  it('still requires auth before it will even consider a takeover', async () => {
    const { bridge, baseUrl } = await fixture();
    const session = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_takeover_unauthorized',
      missionPrompt: 'Ask whether an appointment is available.',
      languageLock: 'English'
    });

    const response = await fetch(`${baseUrl}/agent-call/${session.sessionId}/takeover/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userLanguage: 'English' })
    });

    expect(response.status).toBe(401);
  });
});

describe('bridge bearer auth', () => {
  it('accepts the exact token and rejects near-misses of every shape', async () => {
    const { baseUrl } = await fixture();
    const key = config.BRIDGE_MEDIA_API_KEY;

    const exact = await fetch(`${baseUrl}/agent-call/health`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    expect(exact.status).toBe(200);

    const rejected = [
      `Bearer ${key}x`, // longer
      `Bearer ${key.slice(0, -1)}`, // shorter
      `Bearer ${key.slice(0, -1)}X`, // same length, last byte differs
      `bearer ${key}`, // wrong scheme case
      key, // no scheme
      ''
    ];
    for (const value of rejected) {
      const response = await fetch(`${baseUrl}/agent-call/health`, {
        headers: { Authorization: value }
      });
      expect(response.status, `expected 401 for ${JSON.stringify(value)}`).toBe(401);
    }

    const missing = await fetch(`${baseUrl}/agent-call/health`);
    expect(missing.status).toBe(401);
  });
});
