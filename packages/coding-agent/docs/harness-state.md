# Harness implementation state

Target: `harness.md`. Maintenance-bounded reconstruction after rejecting the previous broad candidate.

## Verified

- Stable committed-snapshot rendering; canonical original-ID tool calls/results; persistence acknowledgements; duplicate, conflicting and unresolved execution refusal.
- Claude-owned durable storage, immutable checkpoint bindings, genuine response IDs, canonical-prefix validation, and fresh-namespace native resume. `/clear`, XML replay and resume-failure replay are removed.
- Real AgentSession + disk v3 + installed native executable against a loopback fake model: cross-project result forks, intermediate signed/redacted-thinking forks, independent cold and concurrent warm continuation, no duplicate effects or branch leakage, prompt replacement, missing-state refusal, and tool/blocked/after-hook/mixed termination.
- Publication refuses incomplete batches, failed canonical acknowledgements, uncommitted native frames, late snapshot mutation, unsupported child histories and fallback text without native frames.
- Final evidence: `harness-final-tests` **138 tests / 16 files**, exit 0; `harness-final-check` full `npm run check`, including browser smoke, exit 0 with no formatting fixes. Earlier unchanged Agent/AI seam evidence: 43 Agent tests and 26 AI tests, exit 0. Counts from overlapping earlier matrices are not additive.
- Generic EventStream, session format v3, parsing, migrations and navigation remain unchanged. SessionManager has only the approved opt-in durable append change (47-line diff), no checkpoint records/indexes.

## Verified maintenance fixup

The fixup returns published checkpoints directly, reuses one incoming-history digest, certifies successive native intervals with position/count boundaries and a serialized publication queue, and scopes memory resources to session cleanup. The unused built-in session-manager capability is removed; registered harnesses retain their public session capability.

`harness-fixup-tests`: **142 tests / 16 files**, exit 0, including real native continuation, 64 sequential rounds with no repeated record scans, a 64-call batch with no scan before all native results, and memory cleanup/late-write fencing. `harness-fixup-final-check`: full root check/browser smoke, exit 0, no fixes applied. The only change after the test run was an explicit public `AbortSignal` type annotation.

## Explicit cut and operating limits

- Native child checkpoint vectors are not implemented. Native child tools remain disabled; observed children prevent exact checkpoint publication, and child resources prevent parent-only staging. They are never silently flattened.
- Partial/unresolved tool batches are not resumable boundaries. Missing checkpoints/resources, including older or imported conversations without native state, fail closed rather than replaying text.
- Moving between profiles requires native resources as well as canonical session files. Native resources live at `agentDir/harness/claude`; memory-only sessions retain them only in process.

Local commit and installation are authorized. No push requested. The rejected candidate is archived at `/Users/amar/.local/state/pi-recovery/claude-harness-7e71ab98/`; its historical test counts do not certify this reconstruction.
