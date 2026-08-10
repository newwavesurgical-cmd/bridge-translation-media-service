# Bridge Translation Media Service

Small realtime media router for Bridge Phone Call Mode.

This service is intentionally separate from the Lovable app. Lovable owns the consumer UI, preflight screen, transcript UI, call controls, and settings. This service owns the long-lived media paths that a normal Lovable Edge Function should not try to hold open:

- App microphone WebSocket from Bridge.
- Twilio bidirectional Media Stream WebSocket.
- Two OpenAI realtime translation WebSocket sessions.
- Audio codec conversion between Twilio `audio/x-mulaw` 8 kHz and OpenAI PCM16 24 kHz.
- In-band DTMF tone generation for IVR keypad testing.

## Architecture

Direction A:

`Bridge app mic -> /app/stream/:callId -> OpenAI translation -> Twilio media -> restaurant hears translated speech`

Direction B:

`Restaurant phone audio -> Twilio media -> OpenAI translation -> /app/stream/:callId -> Bridge app plays translated speech`

The two directions stay separate. The remote party does not install anything and receives a normal telephone call.

## Environment

Copy `.env.example` to `.env` and fill in values.

Required for real calls:

- `OPENAI_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `PUBLIC_BASE_URL`
- `TRANSLATION_MEDIA_PUBLIC_WSS_URL`
- `APP_STREAM_PUBLIC_WSS_URL`
- `BRIDGE_MEDIA_SHARED_SECRET`
- `BRIDGE_MEDIA_API_KEY`
- `DRY_RUN_CALLS=false`

For local route testing, leave `DRY_RUN_CALLS=true`.

## Local Run

```bash
npm install
npm run check
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

Dry-run call creation:

```bash
curl -sS http://localhost:8787/calls \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_SERVICE_API_KEY' \
  -d '{
    "to":"+15555550123",
    "userLanguage":"English",
    "remoteLanguage":"Spanish",
    "announceTranslationAtStart":true,
    "introMessageText":"Hola, llamo para hacer una reservacion para cinco personas.",
    "introDisclaimerText":"Estoy usando un traductor en vivo, asi que puede haber unos segundos de silencio antes de mis respuestas. Gracias por su paciencia.",
    "predictiveMode":"off"
  }'
```

In dry-run mode this returns a `callId`, `callSid:null`, and an `appStreamUrl`, but does not dial Twilio.

## Public URL

Twilio requires a public `wss://` URL for `<Connect><Stream>`. For lab testing, run a tunnel:

```bash
ngrok http 8787
```

Then set:

```bash
PUBLIC_BASE_URL=https://YOUR-NGROK-DOMAIN
TRANSLATION_MEDIA_PUBLIC_WSS_URL=wss://YOUR-NGROK-DOMAIN/twilio/stream
APP_STREAM_PUBLIC_WSS_URL=wss://YOUR-NGROK-DOMAIN/app/stream
DRY_RUN_CALLS=false
```

## HTTP Contract

`GET /health`

Returns booleans for Twilio/OpenAI/router configuration and active-call diagnostics.

`POST /calls`

If `BRIDGE_MEDIA_API_KEY` is configured, include `Authorization: Bearer YOUR_SERVICE_API_KEY`.

Body:

```json
{
  "to": "+525512345678",
  "userLanguage": "English",
  "remoteLanguage": "Spanish",
  "announceTranslationAtStart": true,
  "introMessageText": "Hola, llamo para hacer una reservacion para cinco personas.",
  "introDisclaimerText": "Estoy usando un traductor en vivo, asi que puede haber unos segundos de silencio antes de mis respuestas. Gracias por su paciencia.",
  "predictiveMode": "off"
}
```

`introMessageText` and `introDisclaimerText` are optional text-to-speech blocks played before the Twilio media stream connects. They should already be translated into the remote party's language. If neither custom field is sent and `announceTranslationAtStart` is true, the service plays its default translation announcement.

`predictiveMode` is optional and defaults to `off`. The experimental value `restaurant_reservation_v1` is now a non-substantive bridge-filler mode: after remote speech goes quiet, the service may play a short filler phrase in the remote party's language, such as "Si, claro...", while waiting for the user's real translated answer. It does not predict slot values, does not complete sentences for the user, and does not suppress the normal owner-to-remote translation path.

Response:

```json
{
  "callId": "call_...",
  "callSid": "CA... or null in dry-run",
  "status": "calling or dry_run",
  "appStreamUrl": "wss://.../app/stream/call_...?token=...",
  "diagnostics": {}
}
```

`POST /calls/:callId/dtmf`

If `BRIDGE_MEDIA_API_KEY` is configured, include `Authorization: Bearer YOUR_SERVICE_API_KEY`.

Body:

```json
{ "digit": "1" }
```

Sends an in-band DTMF tone into the Twilio media stream.

`POST /calls/:callId/hangup`

If `BRIDGE_MEDIA_API_KEY` is configured, include `Authorization: Bearer YOUR_SERVICE_API_KEY`.

Closes local media streams. Production deployment should also update the Twilio Call resource to completed.

`GET /twiml/translated-call?callId=...`

TwiML endpoint used by Twilio call origination. It returns `<Connect><Stream>` with custom parameters because Twilio Media Stream WebSocket URLs should not rely on query parameters.

## App WebSocket Contract

Bridge connects to:

`appStreamUrl` from `POST /calls`.

Bridge sends microphone PCM16/24k chunks:

```json
{
  "type": "audio",
  "encoding": "pcm16",
  "sampleRate": 24000,
  "audio": "base64..."
}
```

Bridge receives translated audio for the user:

```json
{
  "type": "translated_audio",
  "speaker": "remote",
  "encoding": "pcm16",
  "sampleRate": 24000,
  "audio": "base64..."
}
```

Bridge receives transcript deltas:

```json
{
  "type": "transcript_delta",
  "speaker": "remote",
  "transcriptKind": "translation",
  "delta": "We have a table at eight..."
}
```

## Current Limits

- Not deployed yet.
- Real Twilio/OpenAI calls are untested until environment variables and a public `wss://` URL are configured.
- The browser app still needs to stream microphone PCM16/24k to `appStreamUrl` and play returned PCM16 audio.
- Hangup currently closes local router sockets; production should also complete the Twilio call through REST.
- DTMF is generated as in-band audio for IVR testing.
