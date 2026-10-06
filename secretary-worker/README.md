# NWE Secretary background worker

The authenticated Bridge server assigns `authenticatedOwnerId` from the signed-in account email. It never accepts a caller-supplied identity. The media service recognizes the canonical `nwe_secretary` profile, uses a separate host prompt, and queues settled transcript turns without the generic caller/operator hold. An optional request tool uses the same utterance key.

The Mac worker polls every two seconds. It uses the existing executive role router and Codex app-server runtime, in isolated ephemeral specialist threads. It never writes to desktop or Telegram threads. SQLite journals jobs before execution; an uncertain attempt is never re-executed. There are at most three active jobs. The phone agent continues independently. Accepted/result events are request-correlated and delivered after a quiet interval. Unrelated chat does not invalidate a result; hangup cancels delivery.

The endpoint accepts Ed25519-signed exact payloads with a 30-second clock window and single-use nonce. Only the public key is in Git. The private key and config live in `~/.codex/nwe-secretary-worker/` with mode 0600. Worker heartbeat expires after 30 seconds; absent or stale means unavailable. A service restart ends its in-memory call jobs; no redial or replay happens.

## Scope

The background execution scope is read, research, and proposal. CFO, Sales/CRM, CEO, Admin, CTO, Quality, Production, Research, Design and Order routes reuse existing source/approval rules. Explicit email requests are delegated to the Admin Codex worker through send_assistant_email.py with fixed NWE Assistant sender Newwaveagental@gmail.com. Personal senders and sender/account overrides are rejected. The immutable per-request journal prevents automatic retries after unknown sends. Sent Mail must be verified before reporting sent. Earlier session results support requests such as email that; only the current user request authorizes sending. Other business-system writes remain disabled. `verifiedMail` remains false for the separate direct-mail UI tool: the secretary delegates through the background worker, not that tool. A returned proposal must never be announced as completed.

## Run

Use the management gateway Python environment, which already has Codex and cryptography dependencies. `worker.py --config ~/.codex/nwe-secretary-worker/config.json`. Config has `url`, `ownerIds`, and `signingKey`; optional `stateDir`. The launchd file is generated locally so it contains no secret or personal paths in Git. A process lock prevents two workers on the same state journal.

`npx tsx secretary-worker/rehearsal.ts` runs the actual Sales/CRM specialist through a local HTTP bridge without dialing or opening a voice session. It verifies receipt in a fake audio adapter, not audible speech. A second question argument selects another read-only rehearsal. The signed production poll API also supports an idempotent `rehearsal` request and `inspectId` for no-dial queue verification.

## Evidence October 4

- Backend build and 367 tests pass, including generic-call regressions, ordinary secretary questions not blocking, owner/freshness isolation, dedupe, cancellation, and signature/tamper/replay rejection.
- Real local CRM rehearsal returned Dr. Ricardo Estape, Miami, with a live CRM record citation despite an intervening weather comment.
- Real local CFO rehearsal returned New Wave Endo-Surgical Corp and realm 9341455977130176 from live QBO connection/company reads.
- These are no-dial worker tests; they do not prove phone audio quality.

## Owner-editable behavior (October 6)

`../secretary-policy.json` is the versioned behavior policy. `conversationRules` adds short rules to the shared phone/web secretary prompt; `workerRules` supplies CFO/source/chart/email details to Codex. Change these instead of adding a long call-specific test mission. Voice-server changes require deployment and a new session; the local worker reads policy for each new job. Personality remains in `src/secretarySupervisor.ts`.

Hospital sales default to NWE documented lifetime M-Close cases, SKU 27-101, monthly cases and trailing 3/6-month averages. CFO resolves hospital aliases and historical coverage. Caller transcript context accompanies phone and web jobs so an email fragment refers to the current deliverable, not a stale completed task. The exact requested SKU is preserved for verification when speech transcription differs.

October 6 regression checks cover context snapshots/session isolation, plain lifetime-sales wording, SAGES research fallback, surgeon routing, chart-email followups, social suppression and fixed-sender email idempotency. The five-minute report timeout and voice breakups observed in the live call are not claimed repaired by these prompt/context changes.
