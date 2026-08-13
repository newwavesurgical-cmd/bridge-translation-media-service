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

In-Person Native Lab:

`Native USB userAudio -> /in-person/stream/:sessionId -> OpenAI translation -> partner translated audio`

`Native USB partnerAudio -> /in-person/stream/:sessionId -> OpenAI translation -> user translated audio`

This path bypasses Twilio. It is for testing dual-channel USB microphone input
from the Android native bridge. Physical channel identity determines routing:
`userAudio` always translates to the partner output, and `partnerAudio` always
translates to the user/private output.

## Environment

Copy `.env.example` to `.env` and fill in values.

Required for real calls:

- `OPENAI_API_KEY`
- `OPENAI_FILLER_TTS_VOICE` is optional and defaults to `onyx` for automatic/default filler voice. `OPENAI_FILLER_TTS_VOICE_MALE` defaults to `onyx`; `OPENAI_FILLER_TTS_VOICE_FEMALE` defaults to `nova`. Filler audio is generated with the Speech API; realtime translation audio uses OpenAI's dynamic translation voice and currently cannot be forced to an identical fixed voice.
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
    "predictiveMode":"off",
    "fillerVoiceGender":"auto"
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

`POST /in-person/sessions`

If `BRIDGE_MEDIA_API_KEY` is configured, include `Authorization: Bearer YOUR_SERVICE_API_KEY`.

Creates a Twilio-free native dual-channel lab session:

```json
{
  "userLanguage": "English",
  "partnerLanguage": "Spanish"
}
```

Response:

```json
{
  "sessionId": "inperson_...",
  "status": "created",
  "streamUrl": "wss://.../in-person/stream/inperson_...?token=...",
  "diagnostics": {}
}
```

Connect the app to `streamUrl`, then send native PCM from the Android bridge:

```json
{
  "type": "dual_audio",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "userAudio": "base64-pcm16-from-owner-mic",
  "partnerAudio": "base64-pcm16-from-partner-mic"
}
```

The server sends translated audio and transcript deltas:

```json
{
  "type": "translated_audio",
  "speaker": "partner",
  "target": "user",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16"
}
```

```json
{
  "type": "translated_audio",
  "speaker": "owner",
  "target": "partner",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16"
}
```

Use `target:"user"` for the owner/private output and `target:"partner"` for the
outward speaker output. Do not infer routing from language or speaker detection.

Phone-only in-person sessions can use the same endpoint without the native USB
bridge. These modes are intentionally labeled as phone-only fallbacks, not true
dual-channel full duplex.

Reliable hold-to-speak mode:

```json
{
  "userLanguage": "English",
  "partnerLanguage": "Spanish",
  "inputMode": "single_mic_hold_to_speak",
  "languageGateMode": "monitor"
}
```

While the user is holding or locking the speaking control, stream microphone
chunks as owner audio:

```json
{
  "type": "audio",
  "speaker": "owner",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16-from-phone-mic"
}
```

When the user releases the control, stream the same physical microphone as
partner audio:

```json
{
  "type": "audio",
  "speaker": "partner",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16-from-phone-mic"
}
```

Experimental automatic phone-only mode:

```json
{
  "userLanguage": "English",
  "partnerLanguage": "Spanish",
  "inputMode": "single_mic_auto"
}
```

If `languageGateMode` is omitted for `single_mic_auto`, the service defaults to
`soft_suppress`. Stream one microphone into both translation directions with:

```json
{
  "type": "single_audio",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16-from-phone-mic"
}
```

The server feeds both translation sessions and uses transcript language gates to
suppress output after confident wrong-language evidence. This can reduce
cross-language pickup, but it is not as reliable as physical channel separation.

The client can keep Auto Detect available while offering a temporary manual
route override. Use this when the UI user taps the English/owner or
Spanish/partner mic button because the automatic detector has not switched
quickly enough:

```json
{
  "type": "set_single_mic_route",
  "route": "owner"
}
```

Valid routes are:

- `auto`: one mic stream is sent to both sessions and language gates choose the
  emitted output.
- `owner`: the next speech start is primed to the owner-language session,
  translating owner language into partner language.
- `partner`: the next speech start is primed to the partner-language session,
  translating partner language into owner language.

The server keeps the selected route for the current utterance, then returns it
to `auto` after the microphone is quiet. If the user taps a route and never
speaks, the override expires after a short armed timeout. The intent is a
temporary per-utterance nudge, not a sticky lock and not a fixed one-second
timer that can cut off long speech.

For low-latency clients, a route can also be sent on an individual audio frame.
Frame routes are one-frame hints and should not be sent continuously for normal
button overrides:

```json
{
  "type": "single_audio",
  "route": "partner",
  "sampleRate": 24000,
  "encoding": "pcm16",
  "audio": "base64-pcm16-from-phone-mic"
}
```

Status messages include `singleMicRoute`, `activeSingleMicRoute`,
`routeOverride`, `routeOverrideAgeMs`, `routeOverrideSpeechAgeMs`, and
`routeOverrideLastSpeechAgeMs` so the UI can light the current listening side.
In automatic mode, `activeSingleMicRoute` reflects the current gate inference
when available; in override mode it mirrors the selected route until the
temporary override returns to `auto`.

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
  "predictiveMode": "off",
  "fillerVoiceGender": "auto"
}
```

`introMessageText` and `introDisclaimerText` are optional text-to-speech blocks played before the Twilio media stream connects. They should already be translated into the remote party's language. If neither custom field is sent and `announceTranslationAtStart` is true, the service plays its default translation announcement.

`predictiveMode` is optional and defaults to `off`. The experimental value `restaurant_reservation_v1` is now a non-substantive bridge-filler mode: after remote speech goes quiet, the service may play a short filler phrase in the remote party's language, such as "Un momento..." or "Si, deme un segundo...", while waiting for the user's real translated answer. It rotates through safe fillers, uses context-aware presence fillers for phrases like "Can you hear me?", does not predict slot values, does not complete sentences for the user, and does not suppress the normal owner-to-remote translation path.

Filler voice note: the filler path uses the Speech API voice configured by `OPENAI_FILLER_TTS_VOICE`. The realtime translation model currently uses dynamic voice adaptation and does not support a fixed voice selection parameter, so the service cannot guarantee that filler and translated speech are perfectly identical.

`fillerVoiceGender` is optional and defaults to `auto`. Supported values are `auto`, `male`, and `female`. `male` uses `OPENAI_FILLER_TTS_VOICE_MALE`; `female` uses `OPENAI_FILLER_TTS_VOICE_FEMALE`; `auto` uses `OPENAI_FILLER_TTS_VOICE`. Current automatic mode does not infer gender from microphone audio yet; it is a default voice mode that can later be upgraded to real voice analysis.

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
