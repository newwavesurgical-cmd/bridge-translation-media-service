import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createBridgeMediaServer } from '../src/http.js';

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

describe('health endpoint privacy', () => {
  it('keeps public health useful without exposing live session diagnostics', async () => {
    const { bridge, baseUrl } = await fixture();
    const session = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_health_privacy',
      missionPrompt: 'Private mission detail',
      languageLock: 'English'
    });
    session.markCalling();

    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      agentCallSupported: true,
      activeAgentCallCount: 1
    });
    expect(payload).not.toHaveProperty('activeAgentCalls');
    expect(payload).not.toHaveProperty('recentAgentCalls');
    expect(JSON.stringify(payload)).not.toContain('agent_health_privacy');
    expect(JSON.stringify(payload)).not.toContain('Private mission detail');
    expect(JSON.stringify(payload)).not.toContain('token=');
  });

  it('returns detailed health only to the authenticated app server', async () => {
    const { bridge, baseUrl } = await fixture();
    const session = bridge.agentCallRegistry.create({
      to: '+15551230000',
      clientSessionId: 'agent_health_authorized',
      missionPrompt: 'Authorized diagnostic detail',
      languageLock: 'English'
    });
    session.markCalling();
    const headers = { Authorization: `Bearer ${config.BRIDGE_MEDIA_API_KEY}` };

    const general = await fetch(`${baseUrl}/health`, { headers });
    const generalPayload = (await general.json()) as Record<string, unknown>;
    expect(general.status).toBe(200);
    expect(generalPayload).toHaveProperty('activeAgentCalls');
    expect(JSON.stringify(generalPayload)).toContain('agent_health_authorized');

    for (const path of ['/agent-call/health', '/agent-call/capabilities']) {
      const publicResponse = await fetch(`${baseUrl}${path}`);
      expect(publicResponse.status).toBe(401);

      const authorizedResponse = await fetch(`${baseUrl}${path}`, { headers });
      const authorizedPayload = (await authorizedResponse.json()) as Record<string, unknown>;
      expect(authorizedResponse.status).toBe(200);
      expect(authorizedPayload).toHaveProperty('activeAgentCalls');
    }
  });
});
