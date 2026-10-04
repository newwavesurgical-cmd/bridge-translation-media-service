# NWE Secretary background worker

The authenticated Bridge server assigns `authenticatedOwnerId` from the signed-in account email. It never accepts a caller-supplied identity. The media service recognizes the canonical `nwe_secretary` profile, uses a separate host prompt, and queues settled transcript turns without the generic caller/operator hold. An optional request tool uses the same utterance key.

The Mac worker polls every two seconds. It uses the existing executive role router and Codex app-server runtime, in isolated ephemeral specialist threads. It never writes to desktop or Telegram threads. SQLite journals jobs before execution; an uncertain attempt is never re-executed. There are at most three active jobs. The phone agent continues independently. Accepted/result events are request-correlated and delivered after a quiet interval. Unrelated chat does not invalidate a result; hangup cancels delivery.

The endpoint accepts Ed25519-signed exact payloads with a 30-second clock window and single-use nonce. Only the public key is in Git. The private key and config live in `~/.codex/nwe-secretary-worker/` with mode 0600. Worker heartbeat expires after 30 seconds; absent or stale means unavailable. A service restart ends its in-memory call jobs; no redial or replay happens.

## Scope

The background execution scope is read, research, and proposal. CFO, Sales/CRM, CEO, Admin, CTO, Quality, Production, Research, Design and Order routes reuse existing source/approval rules. No automatic email sends or business-system writes are enabled. Those still need the established reviewed execution path; `verifiedMail` is false. A returned proposal must never be announced as completed.

## Run

Use the management gateway Python environment, which already has Codex and cryptography dependencies. `worker.py --config ~/.codex/nwe-secretary-worker/config.json`. Config has `url`, `ownerIds`, and `signingKey`; optional `stateDir`. The launchd file is generated locally so it contains no secret or personal paths in Git. A process lock prevents two workers on the same state journal.

`npx tsx secretary-worker/rehearsal.ts` runs the actual Sales/CRM specialist through a local HTTP bridge without dialing or opening a voice session. It verifies receipt in a fake audio adapter, not audible speech. A second question argument selects another read-only rehearsal. The signed production poll API also supports an idempotent `rehearsal` request and `inspectId` for no-dial queue verification.

## Evidence October 4

- Backend build and 367 tests pass, including generic-call regressions, ordinary secretary questions not blocking, owner/freshness isolation, dedupe, cancellation, and signature/tamper/replay rejection.
- Real local CRM rehearsal returned Dr. Ricardo Estape, Miami, with a live CRM record citation despite an intervening weather comment.
- Real local CFO rehearsal returned New Wave Endo-Surgical Corp and realm 9341455977130176 from live QBO connection/company reads.
- These are no-dial worker tests; they do not prove phone audio quality.
