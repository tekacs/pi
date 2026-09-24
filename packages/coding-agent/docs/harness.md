# Embedded harness history

Pi owns canonical assistant and tool-result messages. An embedded harness owns its native conversation, identifiers, storage and continuation rules. Native continuation metadata does not change Pi's session format or tree semantics.

## Core boundary

The integration extends the fork's existing committed-message path. A harness commits an original-ID tool call before executing it and commits its result before delivering that result to the native runtime. Acknowledgement follows awaited host persistence. Committed calls are not executable calls in the outer agent loop. Completed outcomes can be reused; unresolved or conflicting call identities cannot authorize another execution.

Acknowledgement lifetime and cancellation belong to `HarnessOutput`, not the generic EventStream. Registered harnesses construct `HarnessOutput(signal)` when using `runTool`; consumers acknowledge committed messages after persistence. Abandoning a commit, advancing without acknowledgement, closing the output, or cancellation rejects its receipt. Ordinary provider streams retain their existing behavior.

SessionManager supports opt-in durable message append. A failed durable append does not publish a reusable entry and fences subsequent appends until recovery. Ordinary append behavior, session format v3, parsing, migration and navigation are unchanged. AgentSession applies the durability barrier to harness commits.

Harnesses receive existing read-only session identity and entry information. They do not install checkpoint indexes or new journal record types in SessionManager.

## Native continuation

Entering the Claude harness from another provider imports structured canonical history: user and assistant roles, text/images, and completed tool exchanges retain their roles. A return to Claude preserves the last exact native prefix and imports only the intervening foreign suffix. Historical tools are records, never execution requests. This import is a provider transition, not a fallback for damaged or missing Claude checkpoints.

Imported tool IDs are deterministically made Anthropic-compatible and tool names use the same MCP mapping as live calls. Readable foreign reasoning becomes assistant text; opaque foreign reasoning and provider-specific signatures do not transfer. The canonical Pi messages, including their original IDs, remain unchanged. Unresolved, duplicate or mismatched tool exchanges are refused before starting native inference. Empty failed-attempt assistant shells without response identities do not turn a failed first switch into an apparent native resume. Actual Claude history still requires its exact checkpoint.

The first genuine Claude response after import binds the entire canonical prefix to native storage, so later cold resumes and forks use the ordinary checkpoint path. Imports reuse fresh-namespace staging; they add no session records or shared-core APIs.

Interrupted Claude output without tool calls remains visible in canonical history but is not a native continuation boundary. Continuation selects the preceding completed boundary and submits the pending user messages in order, omitting the interrupted display output. A first-turn interruption needs no earlier checkpoint. The canonical fingerprint still includes the interrupted record, so the next completed response certifies the actual Pi history without rewriting it. This classification is explicit: completed native responses, committed calls/results, and nonempty errors never become skippable merely because their checkpoint is absent. Completed tool effects resume through their certified result boundary; unresolved or uncertified exchanges still refuse execution. Inference cancellation does not cancel certification of already acknowledged effects. Publication belongs to the native process lifetime, and terminal turn handling drains it before closing that process. Observed frames wait for durable mirror arrival without a wall-clock deadline: a model can still be generating the remainder of a large tool call. The SDK flushes its mirror before delivering a terminal result; that event closes the publication window and makes any still-missing observed boundary an immediate error. Process teardown and persistence failures also release pending waits.

Claude binds its native state to canonical boundaries in harness-owned storage. A fork at a completed tool result preserves the exchange and permits independent cold continuation of both branches without repeating the tool. Missing or mismatched native state fails explicitly; text replay is not exact continuation.

Claude carries genuine native API response IDs in the existing `AssistantMessage.responseId` field. A tool result locates that ID through its original call ID and the preceding canonical call. Native IDs identify checkpoint resources; a canonical-prefix fingerprint validates the selected boundary rather than guessing conversation identity. Normal v3 forks copy those references with their messages, including a fork exactly at a result, without new Pi metadata records or fork hooks.

Checkpoint publication is separate from canonical commit acknowledgement. A completed result is resumable only when the whole native tool batch is known and every included call/result has canonical and native coverage. Unresolved or partial batches do not acquire a resumable checkpoint. Intermediate output binds to the authoritative native frames it actually includes, not the most recently observed frame of any kind. Publication advances a certified native cursor and validates only the interval after that cursor. Boundaries retain canonical positions rather than copies of cumulative tool sets. The canonical fingerprint is built once per incoming history and continued through publication; final publication returns the checkpoint directly.

Cold continuation stages an opaque append-prefix cut under a fresh native session namespace. The native SDK interprets ancestry through `resumeSessionAt`; Pi does not maintain a parallel Claude ancestry graph. Source logs remain read-only to the new writer and can continue appending independently. Native child resources require their own cuts; the implementation refuses to flatten them into a parent-only continuation.

Native logs and checkpoint bindings live in Claude-owned storage at `agentDir/harness/claude` under the configured agent profile. Memory-only resources belong to the Pi session and are released by session-resource cleanup; a transient invocation without a session ID owns only its own resources. Cross-project forks in that profile retain access to the selected native state. Moving a session to another profile requires its native resources too; a canonical file alone does not claim exact continuation. Native metadata remains directly addressable and independent of warm processes.

The original rendering correction remains independent: the UI finalizes from stable committed snapshots, never from a cleared mutable partial. Terminal errors and aborts render even when the preceding commit already finalized the active display component; the bug-report hint never replaces the actual error.

## Maintenance boundary

No generic EventStream changes, session-format changes, new Pi journal records, migration changes or navigation rewrites are part of this integration. Any requirement that cannot fit those boundaries requires a new explicit decision. Current implementation gaps are in `harness-state.md`.
