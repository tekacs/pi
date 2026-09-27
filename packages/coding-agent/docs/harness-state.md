# Harness implementation state

Target: `harness.md`. Maintenance-bounded reconstruction after rejecting the previous broad candidate.

## Verified

- Stable committed-snapshot rendering; canonical original-ID tool calls/results; persistence acknowledgements; duplicate, conflicting and unresolved execution refusal.
- Claude-owned durable storage, immutable checkpoint bindings, genuine response IDs, canonical-prefix validation, and fresh-namespace native resume. `/clear`, XML replay and resume-failure replay are removed.
- Real AgentSession + disk v3 + installed native executable against a loopback fake model: cross-project result forks, intermediate signed/redacted-thinking forks, independent cold and concurrent warm continuation, no duplicate effects or branch leakage, prompt replacement, missing-state refusal, and tool/blocked/after-hook/mixed termination.
- Publication refuses unresolved calls inside the selected prefix, failed canonical acknowledgements, uncommitted native frames, late snapshot mutation, unsupported child histories and fallback text without native frames.
- Final evidence: `harness-final-tests` **138 tests / 16 files**, exit 0; `harness-final-check` full `npm run check`, including browser smoke, exit 0 with no formatting fixes. Earlier unchanged Agent/AI seam evidence: 43 Agent tests and 26 AI tests, exit 0. Counts from overlapping earlier matrices are not additive.
- Generic EventStream, session format v3, parsing, migrations and navigation remain unchanged. SessionManager has only the approved opt-in durable append change (47-line diff), no checkpoint records/indexes.

## Verified maintenance fixup

The fixup returns published checkpoints directly, reuses one incoming-history digest, certifies successive native intervals with position/count boundaries and a serialized publication queue, and scopes memory resources to session cleanup. The unused built-in session-manager capability is removed; registered harnesses retain their public session capability.

`harness-fixup-tests`: **142 tests / 16 files**, exit 0, including real native continuation, 64 sequential rounds with no repeated record scans, a 64-call batch with no scan before all native results, and memory cleanup/late-write fencing. `harness-fixup-final-check`: full root check/browser smoke, exit 0, no fixes applied. The only change after the test run was an explicit public `AbortSignal` type annotation.

## Verified provider transitions

The Claude-local adapter imports structured foreign-provider history on first entry, and imports only the foreign suffix after an exact native prefix on return. Canonical IDs remain unchanged, historical tools never execute, readable foreign thinking converts to text and opaque foreign signatures do not transfer. Empty failed-switch shells allow retry; unresolved exchanges and missing native checkpoints still fail explicitly.

`claude-switching-final-matrix`: **154 tests / 18 files**, exit 0 on Node 25.6.1. Real AgentSession model switches verify first entry, failed-switch retry, tool-result images and normalized IDs, native result forks, switching away/back while preserving signed/redacted native reasoning, independent cold resume, and refusal after native-resource loss. `claude-switching-final-check`: full root check/browser smoke, exit 0, no fixes. An initial older-runtime run timed out in three existing mocked-fs tests; the complete pinned-runtime matrix passed without changing those tests. The repair is installed locally; Node/Bun consumer smoke tests and installed launcher version/help checks passed. Catalog regeneration was formatting-only; no generated-source drift remains.

## Verified interrupted continuation

Ordinary abort→continue failed because Pi persisted partial thinking with stopReason aborted, while native storage retained only the user request/interruption marker after its valid earlier checkpoint. The adapter incorrectly treated that partial display record as a required native boundary.

The Claude-local selector omits explicit interrupted display output from native input while retaining it in canonical history and its fingerprint. Publication belongs to the native process lifetime, not the inference cancellation signal, and drains before closing. Missing completed boundaries and uncertified effects remain strict.

The interruption matrix passed **163 tests / 19 files**, including real native first-turn/later-turn thinking and text interruption, continuation immediately or after cold reopen, navigation back to interrupted output, completed effects executed once, and refusal of unresolved effects. Full root check/browser smoke passed with no formatting changes. Read-only selection against the originally affected session found its valid earlier native checkpoint and pending users, with the canonical file unchanged.

## Verified mirror timing and terminal errors

A long streamed tool call exposed an invalid 65-second publication deadline: a preceding assistant frame could be observed before the native runtime persisted the completed response. Publication now waits on native durability until the SDK's flushed terminal result, not elapsed time. A missing record at settlement, process closure or persistence failure still fails explicitly. Terminal errors render even after the preceding segment has been committed.

Focused evidence: **44 tests / 5 files**, including simulated two-minute mirror delay, missing-at-settlement and process-close refusal, real native continuation/interruption, and terminal error/abort rendering. Full root check/browser smoke passed with no fixes. Local installation, Node/Bun consumer smoke tests and installed version/help checks passed. No tracked generated-source drift remains.

## Verified streaming-effect prefixes

Publication certifies exact closed call/result prefixes independently of the rest of the model response. Whole-response stop and batch-seal bookkeeping is removed. Unresolved effects inside either selected prefix still prevent continuation.

Focused evidence: **31 tests / 5 files** and full root check/browser smoke passed. The real native regression executes a tool while the same response streams another call, interrupts on native result delivery before transcript flush, then cold-resumes the original and a result fork with the effect executed exactly once and the unfinished call excluded. Unit tests retain unmatched-native-call and unresolved-canonical-call refusal and incremental scan coverage. Existing stored call/result records also passed read-only certification without tool execution or transcript modification. Local installation and Node/Bun SDK, CLI and launcher checks passed. No tracked generated-source drift remains.

## Verified conversation recovery

Exact native checkpoints are optional for conversation continuity. The adapter reconstructs from canonical Pi history when necessary, including interrupted foreign/native responses, missing resources and unresolved exchanges. Reconstruction closes unknown outcomes only in request-local records, preserving the transcript and uncertainty without automatically replaying effects.

Evidence: **72 tests / 9 files** passed, including real native recovery from aborted/error foreign history, legacy native messages, unresolved effects, duplicate/orphan records and missing/corrupt native resources. Cold continuation and unchanged canonical histories are asserted. After a TypeScript narrowing correction in unpaired-result rendering, all **24 import/recovery tests** and the full root check/browser smoke passed. Read-only reconstruction of the originally failing conversation processed 628 canonical messages and closed 151 historical exchanges with no pending calls, transcript changes or tool execution. Local installation, Node/Bun SDK and CLI smoke tests, and installed launcher version/help checks passed. No tracked generated-source drift remains.

## Verified destination-leaf selection

Destination staging explicitly selects its cursor as the native leaf, overriding stale source `last-prompt` metadata before Claude applies `resumeSessionAt`. Original source records remain unchanged; their producer may still append independently.

Evidence: the originally failing native history now resumes successfully against a local endpoint. The store/inbox matrix passed **15 tests / 2 files**, including real extension-triggered wake, native signature preservation, imported suffixes and manual follow-up. The other **23 continuation/switching/recovery/interruption tests** passed in the preceding matrix. Full root checking exposed unrelated stale Fireworks/OpenRouter model-catalog references in AI tests; installation is explicitly authorized without repairing that separate gate. Local installation, Node/Bun consumer smoke tests and installed launcher checks passed. No tracked generated-source drift remains.

## Exact-fidelity limits

- Native child checkpoint vectors are not implemented. Native child tools remain disabled; child resources cannot be staged as exact parent-only cuts. Canonical reconstruction remains available.
- Prefixes containing unresolved calls cannot receive exact checkpoints, but their reconstructed exchanges can be closed with explicit unknown outcomes.
- Native resources at `agentDir/harness/claude` preserve exact fidelity across profiles. Canonical files alone support reconstruction. Memory-only resources last only for the owning process.

The preceding implementation is installed locally via `release:local`. Node/Bun consumer smoke tests and both installed launchers' `--version`/`--help` passed (0.87.1). Its installation regenerated two upstream image-catalog entries; the catalog's 11 tests and post-install root check passed. The interrupted-continuation repair is also installed; its Node/Bun SDK and CLI consumer smoke tests and both installed launchers' version/help checks passed. Catalog regeneration introduced no semantic source changes.
