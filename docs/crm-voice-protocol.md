# CRM GPT-Live transport — protocol 1

This lane uses the existing GPT-Live adapter and a separate CRM reporting
mission. Translation endpoints and their credentials stay separate. It is
disabled by default and must not be used for staff calls before acceptance.

## Configuration

### Management document review extension

Custom mission starts may carry `reviewContext` with UUID `reviewId`, UUID
`documentId`, and string `participantTelegramId`. Before any dial, the bridge
requests the canonical session-bound context from the signed store using
`{action:"review_context",sessionId,...reviewContext,pageNumbers:[]}`. A mismatch
blocks dialing. The CRM must persist that binding before invoking start.

The store returns `{reviewContext:{reviewId,documentId,participantTelegramId,
title,questions,constraints,briefing,pages}}`. With one to four requested
`pageNumbers`, each page has `number`, `text`, `imageBase64`, and `mimeType`
(`image/png` or `image/jpeg`). The store scopes all reads to the session's exact
review/version/participant and uses its private asset storage, never arbitrary URLs.

Only these custom review sessions register `inspect_review_document`. A nested
Responses function call reads exact page images, analyzes them with the configured
backend Responses model (`store:false`), and returns page-cited observations.
All function results are submitted before continuing the delegated response;
audio remains full duplex. Errors produce an explicit unavailable result and
late results after hangup are discarded. No write tools or audio retention are added.

This extension does not activate CRM voice. Configure and independently pilot
the existing scoped connection before any manager calls.

Render worker:

- `CRM_VOICE_STORE_URL=https://lrrjcglcbudcmssilpfh.supabase.co/functions/v1/voice-bridge-store`
- `CRM_VOICE_WEBHOOK_SECRET`: a new random shared secret, at least 32 characters
- `CRM_VOICE_ENABLED=true` only for an authorized controlled call
- Existing OpenAI/Twilio credentials; Twilio's auth token is required to verify callbacks.

CRM functions:

- `VOICE_BRIDGE_BASE_URL=https://bridge-translation-media-service.onrender.com`
- `VOICE_BRIDGE_WEBHOOK_SECRET`: the same scoped secret

Configure secrets in each service's secure settings, never in chat or source.
No OpenAI or Twilio credentials are sent from the worker to the CRM. Do not
reuse the translator's broad service key. The CRM journal endpoint accepts
only health, claim, append and get actions against CRM-created call intents.

## Signing

Every control/store request is POST with `x-nwe-timestamp` (Unix seconds) and
`x-nwe-signature` (lowercase hexadecimal HMAC-SHA256). Sign this exact string:

```
timestamp + '.' + method + '.' + URL.pathname + '.' + exactRawJsonBody
```

The timestamp window is 300 seconds in either direction. Replay protection
for mutations is supplied by durable call claims and immutable event sequence
numbers. Twilio callbacks and the WebSocket handshake use Twilio's own
signature validation against the configured public URL, not a forwarded host.

## Control endpoints

All are under `/crm/voice/`. `health` accepts `{}` and returns configuration,
enabled and store reachability separately. `start` accepts:

```json
{
  "sessionId": "CRM-created UUID",
  "idempotencyKey": "stable caller-generated request ID",
  "to": "+15555550123",
  "targetName": "Optional display name",
  "missionPrompt": "Verified reporting context",
  "reportPeriod": "weekly",
  "language": "English",
  "maxCallDurationSeconds": 900
}
```

`reportPeriod` is weekly/monthly/custom. Max duration is 60–1800 seconds.
Use custom for the general outbound lane: it follows that call's selected
mission, without imposing the staff-report interview questions.
Unknown properties, arbitrary callback URLs, and alternate engines are rejected.
The claim hash is SHA256 of JSON.stringify of the object in the above key
order, targetName omitted if absent, default language English and duration900.
Empty targetName is also omitted. For management reviews, append reviewContext
after maxCallDurationSeconds, with keys reviewId, documentId,
participantTelegramId in that order. Both services use this explicit serializer;
validation-schema property order must never change the claim hash.
The CRM must store this expected hash with its original intent and reject a
claim whose destination/context changed. Exactly one atomic claim may succeed;
an ambiguous claim or dial is never reclaimed automatically.

`status` accepts `{sessionId,sinceSeq?}`. It reads persisted events even after
the media session is gone. Pages may expose hasMore; consumers must not assume
the first page is a complete transcript.

## Journal

Store `health` returns `{ok:true,protocolVersion:1}`. `claim` accepts
`{action,sessionId,idempotencyKey,requestHash}` and returns
`{claimed,session}`. Only an existing CRM intent may be claimed.

`append` accepts `{action,sessionId,events}` and acknowledges `{accepted:true}`
only after transactional persistence. Each event has a positive sequence,
ISO timestamp, type and data. Exact replay is idempotent; conflicting replay
is rejected. Types:

- started: `{callSid}`
- transcript: `{speaker:'agent'|'remote'|'operator',delta}`
- error: `{code}`
- terminal: `{status,finalSeq:previousSequence,transcriptFinal,sessionClosed}`;
  `sessionClosed` is true only after the GPT-Live protocol acknowledges closure.

Preserve delta whitespace and sequence order. Terminal completeness requires
every prior sequence, a confirmed GPT-Live `session.closed` acknowledgement,
both human and assistant speech, and no transport/storage error. Completed
transport remains separate from substantive interview analysis, draft approval,
submission and delivery. For calls outside management document reviews, voicemail
and unknown answering-machine detection hang up and never produce a completed report.

Management document reviews (bound `reviewContext`) omit Twilio AMD and connect
audio on answer without requiring `AnsweredBy=human`. The journal-write guard
still applies. These requested interviews greet the participant by the first
name in the CRM-signed `targetName`, disclose AI identity, and lead concise
questions with focused follow-ups while honoring interruptions. Missing names
use an honest generic greeting; never fabricate a name. With AMD disabled, a
voicemail answer also opens the stream, so machine/human classification is no
longer a guaranteed outcome for this review mode. No automatic redial.

## Honest recovery limits

Call claims and acknowledged transcript fragments are durable in the CRM.
The worker retries each event with the same payload and sequence. If storage
stays down after four attempts, it stops the call and never publishes a complete
terminal event. The answered-call TwiML waits for the initial journal write
before connecting audio. A failure emits only a `crm_journal_unavailable` log
with the session ID; it never logs transcript or credentials. Unsaved fragments
cannot be recovered by repairing the store afterward. A process crash can
lose not-yet-acknowledged fragments and ends live audio; it leaves the report
incomplete and cannot cause automatic redial. This is not seamless media or
unsaved-transcript recovery. Paid always-on hosting is a separate deployment
decision; no service plan is changed by this patch.

## Acceptance before activation

1. `npm run check` (mock calls only).
2. Configure the scoped secret in both services and verify signed readiness.
3. Verify CRM concurrent claims, replay/conflict/gap handling and owner/admin RLS.
4. Make one explicitly authorized controlled call. Check natural interruption,
   at least 15 minutes, ordered complete transcript, an appropriate report
   draft, and separate approval. Check voicemail/incomplete outcomes.
5. Enable a default only after acceptance; never silently fall back after uncertainty.

Weekly qualification is three check-ins, each paired with a completed day
report. They may all be at one institution. Duplicate joins cannot count a
single pair twice. No checkout, duration, quality or units-used gate applies.

References: [Twilio signature validation](https://www.twilio.com/docs/usage/security)
and [GPT-Live guide](https://developers.openai.com/api/docs/guides/live).


## Owner-authorized phone-only reviews (2026-09-17)

Review references accept exactly one identity: the existing numeric
`participantTelegramId`, or the real review `participantId` UUID for a phone-only
contact. Both/absent identities are rejected. Canonical JSON preserves the old
Telegram wire format; phone-only order is `reviewId`, `documentId`, `participantId`.
The signed CRM store must validate that identity against the canonical session,
review, and pinned document. The bridge compares both identity kind and value at
preflight and every document lookup. This grants no new caller-side authority.
`crmVoice.phoneOnlyReviewSupported` advertises compatibility. Phone-only opening
greets the contact by first name without asserting a document was already sent.
Only CRM-owned durable review jobs may initiate this lane; contact registration
alone is not a call request. Callback/check-in routes and Telegram-history policy
remain unchanged.
