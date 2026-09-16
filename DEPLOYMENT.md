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

### User-requested callback research (2026-09-15)

- Before dialing a custom call, query the signed CRM store for
  `callback_capabilities`. Only affirmative server-derived callback authority
  enables CRM search, public research, task retrieval and explicit saved follow-up.
  Reviews/check-ins never query for or receive these tools. Protocol 1 start JSON,
  voice, media transport, opening and AMD behavior are unchanged.
- `callback_tool` uses the current session and provider function `call_id` as
  its stable request ID. No model-supplied identity, destination or SQL is accepted.
  The server must revalidate authority and enforce idempotency on every action.
  Caller transcript is flushed before saving consent. Tool failures cannot count
  as saved commitments; late results cannot enter a closed call.
- Backend contract is additive; unknown/unavailable capability actions disable
  tools without changing existing call startup. Store responses must finish
  within the existing ten-second deadline; slow research returns a durable task
  for polling and server-side continuation. Background delivery belongs to the
  CRM worker and requires a saved explicit delivery request.
- Verification: TypeScript build and 320 synthetic tests pass, including audio
  input while returning a CRM result, role/scope gating, bad arguments, transcript
  persistence, hangup races and provider call ID propagation. No real phone call
  or model-audio test is included in this suite.

### GPT-Live question handoff hardening (2026-09-13)

- Caller transcript fragments now settle only after the existing 650 ms caller
  pause or a genuine agent transcript turn. Outgoing GPT-Live audio packets are
  never treated as caller-turn boundaries, preventing word-by-word question
  bubbles and duplicate observer runs.
- Operator controls carry private context once. Quiet resume/context updates use
  instructions only, while spoken commentary contains only a short callee-facing
  action. After a delivered answer, the listener resumes silently; the answer
  turn itself may ask at most one directly relevant next mission question.
- Controls with both acknowledgments receive a bounded first-audio grace instead
  of being repeated at 1.4 seconds. Missing acknowledgments retry only the missing
  event, with hold/resume-specific wording. Existing deterministic speech fallback
  and Twilio playback checkpoints remain unchanged.
- Short caller fragments such as `3` or `Tuesday` retain the preceding agent
  question in the operator-facing alert and answer context. Contextual observer
  results survive later non-question turns, but resolution, dismissal, a schedule
  scope change, or a newer blocking question invalidates stale results.
- Diagnostics retain a bounded question lifecycle tail (detected, enriched, held,
  answered, dismissed, superseded, observer failure/discard) and separate answer,
  resume, dismissal, and stale-observer counters. No raw audio is recorded.
- The app shows `Answer sending / playing…` and disables question dismissal while
  the matching answer is in flight. The bridge independently ignores a racing
  dismissal for that same answer.
- Automated verification covers acknowledged-vs-missing-ack retries, silent
  control delivery, hold/resume wording, fragment buffering, contextual short
  bubbles, observer races, semantic payload de-duplication, and dismissal races.
  No real call is placed by the test suite. After deployment, accept with one
  English and one Spanish call: answer a short date/time/fact bubble, confirm one
  natural response (and at most one relevant follow-up), dismiss one false
  positive, and verify no repeated hold or post-answer acknowledgement.

### Same-voice GPT-Live greeting (2026-09-13, pending deployment)

- Removed the GPT-Live-only prohibition on greeting before the prepared purpose.
  The startup policy, fresh opening directive and delegated backend now share one
  opening contract: a brief warm Hi / Hola / Olá, the disclosure only when enabled,
  then the prepared purpose, in one configured voice and one turn. Custom text
  already starting with a greeting is preserved without a second prefixed greeting.
- Start promptly without waiting for another hello or delegating the prepared
  opening. No extra spoken clip/event, artificial pause, Twilio Say, or new voice.
  Duplicate session.started events cannot enqueue another opening; late acks and
  later caller hellos cannot replay it. Existing startup watchdogs are unchanged.
- Resolve the greeting from the explicit outbound language lock, including
  en-US/es-ES/pt-BR, ahead of language wording quoted in mission data. This is not
  a claim to have repaired the separate mid-call language-switch anomaly.
- Timing limitation: current synchronous DetectMessageEnd blocks TwiML/media
  until Twilio classifies the answer (or the voicemail greeting ends). The bridge
  then creates the Live connection. No greeting can be heard before that path
  opens. This patch does not change AMD, call routing or preconnect behavior and
  does not prove a reduction in answer-to-first-audible-speech latency. Review
  those timings separately before redesigning the voicemail/connection path.
- Verification: 270 bridge tests and TypeScript build pass. Coverage includes
  toggle on/off, locale locks, custom greetings, immediate post-ack triggering,
  duplicate startup, late acks, mid-call hello and uninterrupted caller input.
  Realtime, main translation, hybrid, operator buttons, Twilio settings, auth,
  credentials and billing are unchanged. No real call or model-audio test ran.
  Not pushed, deployed or published; includes the earlier local recap repair.
- After authorized deployment, test both disclosure settings in English/Spanish:
  one greeting and one mission, same voice; a mid-call hello must not restart it.
  Measure pickup-to-stream, stream-to-agent-ready and ready-to-audible-greeting
  separately. Listen to actual playback; append acknowledgments are not proof.
- References: [OpenAI greeting guidance](https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks),
  [Twilio synchronous AMD](https://www.twilio.com/docs/voice/answering-machine-detection#asyncamd).

### Context-aware repeat confirmations (2026-09-13, pending deployment)

- Retained call `…62fa7078` on `edf112b` contained delivered operator values
  Wednesday and 4 PM, followed by an unnecessary date/time hold. The final
  observer reason said the date was missing from the mission/recent turns.
- Keep call-local approved scheduling fields plus the last 20 delivered
  question/answer pairs. The observer receives these explicitly alongside 12
  reconstructed turns (not just the last 60 fragments). Micro-button instruction
  examples are excluded from conversational memory; button delivery is unchanged.
- Simple English/Spanish read-backs of approved weekday/hour values bypass a
  new alert before any hold. Changed values, missing fields, AM/PM changes,
  added terms, unsupported calendar/relative-date wording and ambiguous phrases
  remain on the existing approval path. No AI-only veto weakens that gate.
- A stale observer result cannot re-open a recognized recap. An answer finishing
  while a recap arrives may resolve that recap, but not a new decision or a
  different appointment. Rejected, dismissed and failed answers are not approval.
- Verification: 254 bridge tests and TypeScript build pass, including the
  scheduling replay, delayed-result races, new appointments, rejected answers,
  changed times, caller quantities, Spanish and instruction-example isolation.
  No frontend, voice/audio transport, routing, secrets, auth or billing changes.
  No call was placed. This repair is not deployed or published yet.
- User acceptance after deployment: choose Wednesday and 4 PM, discuss another
  subject, then ask for the agreed day/time again. Expect one natural read-back,
  no new alert/hold. Propose Thursday or 5 PM and expect a new operator question.
- Separate retained evidence: the same call briefly switched language after a
  4 PM reply. Voice/language handling is deliberately outside this patch.

### GPT-Live post-answer continuity (2026-09-13)

- GPT-Live has no output-audio-done event. Operator speech completion uses local
  PCMU activity plus a Twilio playback checkpoint after 450 ms of streamed quiet
  (or a 650 ms packet gap). A new voiced chunk invalidates an older checkpoint.
  Cleared marks are not completed playback. A lost-checkpoint watchdog releases
  the control without claiming completed playback; it resets while speech continues.
- After an answered question, preserve the exact question/reply as quiet context
  and continue with one mission-specific next step. A day approval is retained as
  a settled fact, never extended to a new time or other commitment. A later
  question cannot be cleared by completion of the earlier answer.
- Exact-say, takeover, startup, credentials, billing, main translation, and hybrid
  configuration are unchanged. No real calls are part of automated verification.
- References: [OpenAI Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets),
  [Live context updates](https://developers.openai.com/api/docs/guides/live-conversations#provide-history-and-context),
  [Twilio marks and clear](https://www.twilio.com/docs/voice/media-streams/websocket-messages#mark-message).
- Manual acceptance after deployment: approve Wednesday, verify the spoken answer
  continues to asking for time options, check that noon still requires approval,
  and say hello mid-call to verify it continues the topic without restarting intake.

Twilio bidirectional Media Streams receive phone audio and accept `media` messages back to the call. The current keypad path sends audible DTMF tones through that media stream for lab IVR testing. Treat this as a prototype behavior, not guaranteed production DTMF delivery.

OpenAI Realtime Translation expects continuous base64 PCM16 at 24 kHz through `session.input_audio_buffer.append` and returns translated audio through `session.output_audio.delta`. Keep streaming silence between phrases; do not build a push-to-talk turn system around phone calls.
