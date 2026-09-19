# Authenticated supervised outbound-call adapter — design checkpoint

Status: design only. The bridge decision-mode branch is not deployed; no Codex,
Bossman, or Telegram adapter is enabled. This extends the app contract in
`github-translator-app/docs/supervised-outbound-call-gateway.md` without creating
a second dialing path or granting an external actor the bridge API key.

## Ownership and trust boundary

- The Translator App backend is the only public call authority. Browser users
  authenticate with the existing account session. The NWE Assistant gateway
  authenticates to a new app-owned server-to-server interface with a narrowly
  scoped, short-lived signed assertion. The assertion identifies the verified
  Telegram sender and mapped, active app user; an arbitrary Telegram ID, prompt,
  or conversation summary cannot choose the billable account. No browser or
  Telegram client receives the media-service key, service-role key, provider
  credentials, recording URL, or monitor/takeover stream token.
- The app validates actor, account, destination, requested engine, call purpose,
  decision mode, duration, and per-session operation permissions before it
  calls the bridge. It reuses the existing prepare/normalization/disclosure,
  final-prompt budget, admin-only GPT-Live gate, and minute-reservation logic.
  A dry run never reserves minutes or dials.
- The app owns the durable intent, account reservation, session mapping,
  transcript/event journal, and recording authorization. The bridge owns the
  single live Twilio/media session and its agent state. The cockpit displays
  that same canonical session; Telegram receives status and pending-decision
  notices, not an independent transcript or calling runtime.

## Proposed app-owned API

All routes are authenticated, account-scoped, rate-limited, and audited. JSON
responses omit secret-bearing bridge URLs. The exact URL names are provisional;
the identity, state, and idempotency semantics are not.

| Operation | Request | Result and guard |
| --- | --- | --- |
| `POST /api/agent-call/intents` | Stable `{source, sourceRequestId, destination, mission, constraints, successCriteria, decisionMode, languageLock, maxSeconds}` | Create or return the same durable intent after request-hash validation; run app Prepare without dialing. Return `intentId`, safe preview, `armed`, warnings, and account readiness. Same key/different body is `409`. |
| `POST /api/agent-call/intents/:id/start` | Intent ID plus stable `startKey` and explicit initiation authorization | Atomically claim the intent, reserve seconds once for the mapped app user, persist requested session ID, then initiate at most one bridge call. Return the app's `callId`, canonical `sessionId`, call status, and cockpit deep link. A repeated key returns the stored result or `uncertain`; it never redials. |
| `GET /api/agent-call/:callId` | Optional event cursor | Authorize actor/account on every request; return current state, canonical session ID, transcript events, pending question, IVR, decision mode, recording state, and next cursor. No secret URL. |
| `POST /api/agent-call/:callId/control` | Stable operation key, typed guidance/quick reply/decision-mode/DTMF/end action | Validate scope, call state, idempotency and the exact canonical session mapping; proxy one control to the bridge. Return delivered/queued/failed evidence. No silent replay of an uncertain speech action. |
| `GET /api/agent-call/:callId/recordings` and `GET /.../recordings/:recordingId` | Same caller/owner authorization | App validates call ownership and provider recording membership, then proxies a bounded, no-store stream; never returns a reusable provider or bridge credential. |

The app cockpit should adopt `callId` and its canonical `sessionId` through an
authenticated return-to-call route. Listen-only playback, transcript, pending
questions, guidance, quick replies, takeover, decision-mode changes, and hangup
must all target that record. Voice takeover still requires a privileged live
cockpit and its normal microphone permission; Telegram does not acquire a mic.

## Durable start and recovery

Use one database row unique on `(source, verifiedActorId, sourceRequestId)` with
a normalized request hash, mapped app `userId`, app `callId`, requested bridge
session ID, canonical bridge session ID, provider `callSid`, reservation ID,
state, last event sequence, timestamps, and error classification. Store mission
content separately under account access controls. A state transition is a
compare-and-swap transaction, not a client-side lock:

`draft -> prepared -> start_claimed -> reserved -> dialing -> live -> terminal`

`dialing` may become `start_uncertain` if the bridge request times out or the
worker dies. Never release the reservation or retry the dial merely because
the HTTP response was lost. Reconcile in order: persisted app receipt, exact
bridge session ID, exact callback/provider call ID, and provider evidence. If
none can prove no call was made, keep `start_uncertain` for owner review. A
terminal callback and authenticated hangup finalize the existing reservation
idempotently; a failed pre-dial validation releases it only with proof that
origination never began. The existing `reserve_call_seconds` RPC does **not**
deduplicate `session_ref`; the new intent transaction must claim/guard it.

Before unattended start, the bridge must accept a stable `clientSessionId` and
idempotency key plus request hash, return the original session/call SID for an
exact repeat, reject a conflicting repeat, and retain enough durable evidence
across restarts for reconciliation. Currently `/agent-call/start` creates a
session and originates a call every time, and a duplicate `clientSessionId`
would replace an in-memory registry entry. The app currently sends `sessionId`
in its bridge payload, not the bridge's `clientSessionId`, so the bridge chooses
a new ID. Both sides need one explicit canonical mapping before external start.

## Transcript, guidance, and recording

- Persist ordered, bounded events keyed by `(callId, sequence)` with speaker,
  finality, source timestamp, and bridge event ID; checkpoint the last sequence
  before telling Telegram an answer was captured. Poll/stream the same source
  into the cockpit, with cursor resume after process or network interruption.
  The bridge's in-memory transcript tail/recent diagnostics are not a durable
  final record today.
- Guidance and decision-mode switches use a per-call operation key. The app
  returns bridge delivery evidence, not merely an HTTP success. High-impact
  facts and approvals must be attributable to the authenticated operator and
  never inferred from a Telegram transport acknowledgment. The bridge's
  hard-stop classification remains authoritative during Best judgment.
- Twilio dual-channel recording is enabled at bridge origination. The existing
  call-bound recording list/playback routes belong to the separate CRM voice
  protocol, not to `/agent-call`; the adapter needs its own app-authorized,
  session-bound recording read path backed by a durable call SID mapping.
  Report `processing`, `available`, or `unavailable` honestly. Decide notice,
  access, and retention policy before a live rollout; do not assume a recording
  is available just because the provider accepted `record: true`.

## Security and release gates

1. Add authentication **and ownership checks before bridge access** to the
   existing app status, control, DTMF, and legacy end server functions. Some of
   those functions currently lack `requireSupabaseAuth`; authenticated end
   currently checks its minute record only *after* asking the bridge to end.
   Merely knowing a session ID must never authorize transcript reads, speech,
   DTMF, mode changes, or hangup. Keep the ordinary browser cockpit working.
2. Add the durable intent/operation tables and bridge start idempotency with
   conflict, concurrent-request, timeout, callback-before-response, restart,
   and uncertain-start tests. Verify reservation is held once and settled once.
3. Add owner-scoped transcript/recording reads and negative authorization
   tests, then no-dial prepare and dry-run end-to-end checks from both browser
   and Telegram identities. Test mode switches and hard stops in the same
   canonical session, including a missing fact while Best judgment is active.
4. Only after explicit release approval, deploy the bridge and app backend in
   separate steps, verify version/capability parity, and enable the adapter
   behind a default-off feature flag. A real test call requires its own explicit
   destination and authorization; no call is part of this design checkpoint.

The existing published Translator App remains untouched. The bridge
`codex/outbound-call-recordings` branch may be fast-forward merged after its
safety tests pass and review is complete, but merging code is not a Render
deployment, a Lovable publish, or permission to place a call.
