import twilio from 'twilio';
import type { AppConfig } from '../config.js';

/** Applied at origination so the first answered audio and both speakers are captured. */
export const callRecordingOptions = { record: true, recordingChannels: 'dual', recordingTrack: 'both' } as const;
export interface CallRecording {
  sid: string; status: string; durationSeconds: number; channels: number; dateCreated: string | null;
}
export interface RecordingAccess {
  list(callSid: string): Promise<CallRecording[]>;
  media(callSid: string, recordingSid: string, format: 'mp3' | 'wav'): Promise<Buffer>;
}
export class RecordingError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
const validCall = (sid: string) => /^CA[a-f0-9]{32}$/i.test(sid);
const validRecording = (sid: string) => /^RE[a-f0-9]{32}$/i.test(sid);
export function recordingState(recordings: CallRecording[]): 'available' | 'processing' | 'unavailable' {
  if (recordings.some(r => r.status === 'completed')) return 'available';
  return recordings.some(r => ['in-progress', 'paused', 'stopped', 'processing'].includes(r.status)) ? 'processing' : 'unavailable';
}
export function createRecordingAccess(config: AppConfig): RecordingAccess {
  function credentials() {
    const account = config.TWILIO_ACCOUNT_SID;
    const user = config.TWILIO_API_KEY_SID && config.TWILIO_API_KEY_SECRET ? config.TWILIO_API_KEY_SID : account;
    const password = config.TWILIO_API_KEY_SID && config.TWILIO_API_KEY_SECRET ? config.TWILIO_API_KEY_SECRET : config.TWILIO_AUTH_TOKEN;
    if (!account || !user || !password) throw new RecordingError(503, 'recording_provider_unavailable');
    return { account, user, password };
  }
  const access: RecordingAccess = {
    async list(callSid) {
      if (!validCall(callSid)) throw new RecordingError(404, 'call_not_found');
      const { account, user, password } = credentials();
      const client = twilio(user, password, { accountSid: account, timeout: 15000 });
      const rows = await client.calls(callSid).recordings.list({ limit: 100 });
      // Defense in depth: ignore any record that does not belong to this exact call/account.
      return rows.filter(r => r.callSid === callSid && r.accountSid === account && validRecording(r.sid)).map(r => ({
        sid: r.sid, status: r.status, durationSeconds: Math.max(0, Number(r.duration) || 0),
        channels: r.channels, dateCreated: r.dateCreated?.toISOString() ?? null,
      }));
    },
    async media(callSid, recordingSid, format) {
      if (!validCall(callSid) || !validRecording(recordingSid) || !['mp3', 'wav'].includes(format)) {
        throw new RecordingError(404, 'recording_not_found');
      }
      const bound = (await access.list(callSid)).find(r => r.sid === recordingSid);
      if (!bound) throw new RecordingError(404, 'recording_not_found');
      if (bound.status !== 'completed') throw new RecordingError(409, 'recording_not_ready');
      const { account, user, password } = credentials();
      const url = `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recordingSid}.${format}?RequestedChannels=2`;
      // Fetch follows the provider's media redirect; standard fetch strips Authorization across origins.
      const response = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') },
        signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) throw new RecordingError(response.status === 404 ? 404 : 503, 'recording_media_unavailable');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024 * 1024) { throw new RecordingError(503, 'recording_media_too_large'); }
        chunks.push(Buffer.from(chunk));
      }
      if (!bytes) throw new RecordingError(503, 'recording_media_empty');
      return Buffer.concat(chunks);
    },
  };
  return access;
}

/** Old missions may still contain the former retention policy; preserve their stored evidence. */
export function currentRecordingInstructions(text: string): string {
  return text.replace(/(?:and\s+)?(?:the\s+)?call audio (?:itself )?(?:is not|isn't|isn’t) (?:retained|kept)\.?/gi, '')
    .replace(/no retained call audio\.?/gi, '').replace(/and\s*\./g, '.');
}
