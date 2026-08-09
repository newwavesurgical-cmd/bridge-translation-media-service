import twilio from 'twilio';
import type { AppConfig } from '../config.js';
import type { CallSession } from '../callRegistry.js';

export async function originateTranslatedCall(config: AppConfig, session: CallSession): Promise<string | null> {
  if (config.DRY_RUN_CALLS) {
    return null;
  }
  if (!config.PUBLIC_BASE_URL || !config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio call origination is not configured');
  }

  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  const twimlUrl = new URL('/twiml/translated-call', config.PUBLIC_BASE_URL);
  twimlUrl.searchParams.set('callId', session.callId);

  const call = await client.calls.create({
    to: session.data.to,
    from: config.TWILIO_PHONE_NUMBER,
    url: twimlUrl.toString(),
    statusCallback: new URL('/twilio/status', config.PUBLIC_BASE_URL).toString(),
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST'
  });

  return call.sid;
}

export async function completeTwilioCall(config: AppConfig, callSid: string | null): Promise<void> {
  if (config.DRY_RUN_CALLS || !callSid) {
    return;
  }
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio call completion is not configured');
  }

  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  await client.calls(callSid).update({ status: 'completed' });
}
