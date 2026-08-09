export type Speaker = 'owner' | 'remote';
export type TranscriptKind = 'source' | 'translation';

export type AppClientMessage =
  | {
      type: 'start';
      callId?: string;
    }
  | {
      type: 'audio';
      audio: string;
      sampleRate?: 24000;
      encoding?: 'pcm16';
    }
  | {
      type: 'dtmf';
      digit: string;
    }
  | {
      type: 'hangup';
    };

export type AppServerMessage =
  | {
      type: 'status';
      callId: string;
      state: string;
      twilioConnected: boolean;
      appConnected: boolean;
      sessionA: string;
      sessionB: string;
    }
  | {
      type: 'translated_audio';
      speaker: Speaker;
      audio: string;
      sampleRate: 24000;
      encoding: 'pcm16';
    }
  | {
      type: 'transcript_delta';
      speaker: Speaker;
      transcriptKind: TranscriptKind;
      delta: string;
    }
  | {
      type: 'error';
      message: string;
    };

export type TwilioMediaMessage =
  | {
      event: 'connected';
      protocol: string;
      version: string;
    }
  | {
      event: 'start';
      sequenceNumber: string;
      streamSid: string;
      start: {
        streamSid: string;
        accountSid: string;
        callSid: string;
        tracks: string[];
        mediaFormat: {
          encoding: 'audio/x-mulaw';
          sampleRate: 8000;
          channels: 1;
        };
        customParameters?: Record<string, string>;
      };
    }
  | {
      event: 'media';
      sequenceNumber: string;
      streamSid: string;
      media: {
        track?: 'inbound' | 'outbound';
        chunk?: string;
        timestamp?: string;
        payload: string;
      };
    }
  | {
      event: 'dtmf';
      sequenceNumber: string;
      streamSid: string;
      dtmf: {
        track: 'inbound_track';
        digit: string;
      };
    }
  | {
      event: 'mark';
      sequenceNumber: string;
      streamSid: string;
      mark: {
        name: string;
      };
    }
  | {
      event: 'stop';
      sequenceNumber: string;
      streamSid: string;
      stop: {
        accountSid: string;
        callSid: string;
      };
    };

export interface CreateCallRequest {
  to: string;
  userLanguage: string;
  remoteLanguage: string;
  announceTranslationAtStart?: boolean;
  clientCallId?: string;
}

export interface CreateCallResponse {
  callId: string;
  callSid: string | null;
  status: 'dry_run' | 'calling';
  appStreamUrl: string;
  diagnostics: Record<string, unknown>;
}
