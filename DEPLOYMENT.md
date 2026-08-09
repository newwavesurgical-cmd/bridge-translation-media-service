# Bridge Translation Media Service Deployment

This service is the persistent realtime media router for Bridge Phone Call Mode. Lovable stays responsible for the UI and server-side proxy calls, while this service owns Twilio Media Streams, OpenAI Realtime Translation sessions, and app audio WebSockets.

## Required Production Variables

Set these on the media service host:

- `PUBLIC_BASE_URL`: `https://YOUR-SERVICE-HOST`
- `TRANSLATION_MEDIA_PUBLIC_WSS_URL`: `wss://YOUR-SERVICE-HOST/twilio/stream`
- `APP_STREAM_PUBLIC_WSS_URL`: `wss://YOUR-SERVICE-HOST/app/stream`
- `OPENAI_API_KEY`
- `OPENAI_TRANSLATION_MODEL`: `gpt-realtime-translate`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN` or `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`
- `TWILIO_PHONE_NUMBER`
- `BRIDGE_MEDIA_SHARED_SECRET`: long random secret used for WebSocket tokens
- `BRIDGE_MEDIA_API_KEY`: long random API key used by the Lovable backend proxy
- `DRY_RUN_CALLS`: keep `true` until health checks pass, then set `false` for real calls

Set these in Lovable/Supabase, not in browser code:

- `TRANSLATION_MEDIA_SERVICE_URL`: same value as `PUBLIC_BASE_URL`
- `TRANSLATION_MEDIA_SERVICE_API_KEY`: same value as `BRIDGE_MEDIA_API_KEY`

## Smoke Test Order

1. Deploy with `DRY_RUN_CALLS=true`.
2. Confirm `GET /health` returns:
   - `twilioConfigured: true`
   - `openAiConfigured: true`
   - `mediaRouterConfigured: true`
   - `dryRunCalls: true`
3. Configure Lovable with `TRANSLATION_MEDIA_SERVICE_URL` and `TRANSLATION_MEDIA_SERVICE_API_KEY`.
4. In Bridge Phone Call Lab, confirm:
   - `TRANSLATIONMEDIASERVICEURLPRESENT yes`
   - `MEDIASERVICEAPIKEYPRESENT yes`
   - `MEDIAROUTERCONFIGURED true`
   - `CANPLACETRANSLATEDCALL true`
5. Use a test number only. Place a dry-run call from Bridge and confirm the app receives an `appStreamUrl`.
6. Set `DRY_RUN_CALLS=false`.
7. Place one explicit test call after confirming the destination number.

## Notes

Twilio bidirectional Media Streams receive phone audio and accept `media` messages back to the call. The current keypad path sends audible DTMF tones through that media stream for lab IVR testing. Treat this as a prototype behavior, not guaranteed production DTMF delivery.

OpenAI Realtime Translation expects continuous base64 PCM16 at 24 kHz through `session.input_audio_buffer.append` and returns translated audio through `session.output_audio.delta`. Keep streaming silence between phrases; do not build a push-to-talk turn system around phone calls.
