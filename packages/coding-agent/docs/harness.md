# Embedded harness history

Pi owns canonical assistant and tool-result messages. An embedded harness owns its native conversation, identifiers, storage and continuation rules. Native continuation metadata does not change Pi's session format or tree semantics.

## Core boundary

The integration extends the fork's existing committed-message path. A harness commits an original-ID tool call before executing it and commits its result before delivering that result to the native runtime. Acknowledgement follows awaited host persistence. Committed calls are not executable calls in the outer agent loop. Completed outcomes can be reused; unresolved or conflicting call identities cannot authorize another execution.

Acknowledgement lifetime and cancellation belong to `HarnessOutput`, not the generic EventStream. Registered harnesses construct `HarnessOutput(signal)` when using `runTool`; consumers acknowledge committed messages after persistence. Abandoning a commit, advancing without acknowledgement, closing the output, or cancellation rejects its receipt. Ordinary provider streams retain their existing behavior.

SessionManager supports opt-in durable message append. A failed durable append does not publish a reusable entry and fences subsequent appends until recovery. Ordinary append behavior, session format v3, parsing, migration and navigation are unchanged. AgentSession applies the durability barrier to harness commits. Harnesses receive existing read-only session identity and entry information; they do not install checkpoint indexes or journal record types in SessionManager.

## Conversation continuity

Readable Pi history is sufficient to continue in Claude. Exact native continuation preserves additional fidelity when available; it is not a prerequisite for continuing the conversation. Provider switches, aborted or failed responses, unfinished tool exchanges, old conversations, and unavailable or damaged native resources take the structured reconstruction path when exact continuation is unavailable.

The adapter selects the latest valid checkpoint and imports the suffix after it. Without a usable checkpoint it reconstructs the canonical history. If the selected native resource cannot be staged, reconstruction happens before starting inference. It never retries an inference after effects might have executed.

Reconstruction preserves user/assistant roles, text, supported images, tool arguments and recorded results. Readable reasoning becomes ordinary assistant text; opaque reasoning and signatures do not transfer. Incomplete assistant content is retained with an interruption/error annotation. Empty terminal shells require no native input. Canonical messages and IDs are unchanged; the entire canonical prefix, including interrupted records, remains in the next checkpoint's fingerprint.

Historical calls are records, never execution requests. Their request-local IDs are normalized for Anthropic and tool names use the live MCP mapping. An exchange lacking a recorded result is closed in the reconstructed request with an explicit error result: interrupted, outcome unknown, changes may already have occurred, inspect current state before any repeat. This closes the conversation exchange only; it does not claim that an underlying operation was cancelled or rolled back. Existing execution cancellation remains signal-driven. Any later recorded result is retained as evidence, even when no longer pairable. Duplicate/conflicting call records and unmatched results are retained as readable records rather than invalid native tool exchanges. No synthetic outcome is written into the canonical transcript.

The first completed Claude response after reconstruction binds the actual canonical prefix to fresh native state. Subsequent restart/fork operations can again use exact continuation. Canonical tool-execution guards remain strict: reconstruction never grants permission to execute an old unresolved call.

## Exact native checkpoints

Claude carries genuine API response IDs in `AssistantMessage.responseId`. Original call IDs connect results to their response. A canonical-prefix fingerprint validates checkpoint identity; ordinary v3 forks preserve references without new metadata records or fork hooks.

Publication certifies a durable prefix in which every included call has its matching canonical/native result. Later frames outside that cut do not prevent certification. Model `message_stop` and whole-batch hooks are not checkpoint gates; the batch hook handles only tool-requested termination. Unresolved effects inside the selected prefix, uncommitted frames and mutated snapshots prevent exact publication, not future reconstructed conversation.

Publication problems never fail a completed turn. A refused or failed checkpoint (mismatched intervals, missing mirror records, native storage failures, unsupported children) marks the invocation's publication degraded: later boundaries in that invocation are not certified, the response completes normally, and the next turn resumes from the latest valid checkpoint plus reconstruction. Only canonical persistence failures fail a turn.

The native runtime can settle tool calls without reaching Pi: an unknown tool name, or an MCP request Pi cannot serve, produces a native error result that Pi never executed. When such a result arrives, Pi commits the original-ID call and the native result canonically before certification, keeping both histories aligned. These records describe outcomes the runtime already produced; they are never executed.

Publication advances a certified cursor through disjoint native intervals rather than repeatedly scanning growing histories. Observed frames await persistence without a generation deadline. The SDK flushes its mirror before delivering its terminal result; settlement then rejects still-missing boundaries. Inference cancellation does not cancel publication of already acknowledged effects. Native process teardown and persistence failures release pending waits.

Cold native continuation stages an immutable opaque prefix under a fresh namespace. The destination receives an explicit native `last-prompt` leaf selection pointing to the selected cursor, overriding stale source branch-selection metadata without changing source records. The SDK loads that selected branch before applying `resumeSessionAt`; Pi does not maintain a second ancestry graph. Source logs remain independent. Native child-vector cuts are not implemented; resources requiring those cuts use canonical reconstruction instead of claiming exact parent-only continuation.

Logs and immutable bindings live at `agentDir/harness/claude`. Memory-only resources belong to their Pi session and are released on cleanup. Copying canonical history between profiles remains sufficient for reconstruction; copying native resources as well preserves exact fidelity.

## Rendering and maintenance

The UI finalizes stable committed snapshots, not cleared mutable partials. Terminal errors and aborts render even after a commit finalized the active display component; the bug-report hint never replaces the actual error.

Generic EventStream, session-format v3, migration and navigation remain unchanged. Current implementation gaps and verification are recorded in `harness-state.md`.
