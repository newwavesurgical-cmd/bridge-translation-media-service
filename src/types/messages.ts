export type Speaker = 'owner' | 'remote';
export type TranscriptKind = 'source' | 'translation';
export type PredictiveMode = 'off' | 'restaurant_reservation_v1';
export type FillerVoiceGender = 'auto' | 'male' | 'female';
export type LanguageGateMode = 'off' | 'monitor' | 'soft_suppress' | 'strict_suppress';
export type InPersonInputMode = 'dual_channel' | 'single_mic_hold_to_speak' | 'single_mic_auto';

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
      ivr?: unknown;
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
      type: 'predictive_event';
      event:
        | 'turn_started'
        | 'prefix_audio_started'
        | 'slot_resolved'
        | 'completion_audio_started'
        | 'turn_timeout'
        | 'unsupported_language'
        | 'speech_error';
      mode: PredictiveMode;
      slot?: string;
      intent?: string;
      text?: string;
      detail?: string;
      at: string;
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
  introMessageText?: string;
  introDisclaimerText?: string;
  predictiveMode?: PredictiveMode;
  fillerVoiceGender?: FillerVoiceGender;
  clientCallId?: string;
}

export interface CreateCallResponse {
  callId: string;
  callSid: string | null;
  status: 'dry_run' | 'calling';
  appStreamUrl: string;
  diagnostics: Record<string, unknown>;
}

export interface CreateInPersonSessionRequest {
  userLanguage: string;
  partnerLanguage: string;
  clientSessionId?: string;
  inputMode?: InPersonInputMode;
  languageGateMode?: LanguageGateMode;
}

export interface CreateInPersonSessionResponse {
  sessionId: string;
  status: 'created';
  streamUrl: string;
  displayStreams?: {
    owner: {
      view: 'owner';
      target: 'user';
      streamUrl: string;
    };
    partner: {
      view: 'partner';
      target: 'partner';
      streamUrl: string;
    };
  };
  diagnostics: Record<string, unknown>;
}

export interface CreateAppToAppSessionRequest {
  initiatorLanguage: string;
  receiverLanguage: string;
  clientSessionId?: string;
  fillerBridgeEnabled?: boolean;
  fillerVoiceGender?: FillerVoiceGender;
  predictiveMode?: PredictiveMode;
  languageGateMode?: LanguageGateMode;
}

export interface CreateAppToAppSessionResponse {
  sessionId: string;
  status: 'created';
  initiatorStreamUrl: string;
  receiverStreamUrl: string;
  inviteUrlPath: string;
  diagnostics: Record<string, unknown>;
}
