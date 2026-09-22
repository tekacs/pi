# Context projection: verification and deployment

Target behavior is documented in [session-format.md](session-format.md#customentry)
and the agent core's [request-boundary contract](../../agent/README.md#request-boundary-context-refresh).

## Request adoption

The old runtime updates `agent.state.messages` for a projection write while the
active loop continues with a separate copied array. A faux-provider reproduction
confirmed that request 2 retains originals after a successful fold, even though
session materialization and agent state both select the fold.

The source repair introduces a final `prepareRequest` boundary, coalesces
active-run projection invalidations, and materializes after message/tool
persistence. It also refreshes before between-turn compaction checks and at
final settlement. Transient prompts survive snapshot replacement without
becoming durable.

The live failure also folded a native compaction entry carrying the complete
system/tool checkpoint. Projection now preserves control messages independently
of source content, including that embedded baseline and later patches. The
screenshot's orphan tool-result error is consistent with projection replacement
inside an assistant message_end hook before its call was persisted: the durable
transcript contains the complete exchange, but the running state lost the call.
A dedicated regression checks that call inside tool execution as well as the
following outgoing request. These repairs are installed locally as of 2026-09-22.

## Evidence — 2026-09-22

- Full `npm run check` passes (format/lint, dependency/import/entry-graph/lock
  checks, TypeScript, browser smoke).
- 40 coding-agent tests pass across six files; five real-provider compaction
  e2e tests were skipped. 55 agent-core tests pass across two files.
- The new faux-provider regressions cover fold/restore in one parallel or
  sequential run, lifecycle writes, preservation of the active assistant call,
  transient triggers, queued custom/steering messages, no rebuilding unchanged
  requests, terminating runs, and tool restoration after a folded compaction.
- Read-only replay of the actual failing session at five historical leaves
  preserves all 26 tool declarations with the fix, versus three at four of
  those leaves beforehand. The durable call/result exchange was intact.
- No real provider calls were made. Logs: `/tmp/posture-history-assessment/pi-*.log`.

## Local deployment — 2026-09-22

Amar authorized the local build/install. `npm run build:offline` and the native
Darwin ARM64 binary recipe passed without changing the model catalog. All local
packages were packed and installed with scripts disabled into isolated Node and
Bun consumer trees. SDK/CLI packaging smoke tests passed in both runtimes.

The standalone Bun binary and Node CLI both passed an uninterrupted faux-provider
fold/expand run, including an assistant `message_end` projection and a companion
tool result, in print and interactive modes. The packaged Node and Bun SDKs
replayed the five actual failure leaves with all 26 declarations intact and
restored read/bash/edit/write on resume. No paid provider calls were made.

The verified tree is installed at `/Users/amar/.local/share/pi-local`, reached
by `/Users/amar/bin/pi`. Executable-module comparisons match the built workspace.
The former tree is preserved at
`/Users/amar/.local/share/pi-local-before-projection-20260922`.
Already-running processes still require a restart; `/reload` only reloads
extensions and cannot replace the core runtime. Source changes remain in the
working copy; no commit or public push was authorized for this Pi checkout.

Posture's continuation notice in the screenshot was a response to the failed
provider request. Its old failed gate finding is separate retained diagnostic
state; this Pi change does not alter Posture's resource acknowledgment policy.
