# Embedded harness history

Pi owns canonical assistant and tool-result messages. An embedded harness owns its native conversation, identifiers, storage and continuation rules. Native continuation metadata does not change Pi's session format or tree semantics.

## Core boundary

The integration extends the fork's existing committed-message path. A harness commits an original-ID tool call before executing it and commits its result before delivering that result to the native runtime. Acknowledgement follows awaited host persistence. Committed calls are not executable calls in the outer agent loop. Completed outcomes can be reused; unresolved or conflicting call identities cannot authorize another execution.

Acknowledgement lifetime and cancellation belong to `HarnessOutput`, not the generic EventStream. Registered harnesses construct `HarnessOutput(signal)` when using `runTool`; consumers acknowledge committed messages after persistence. Abandoning a commit, advancing without acknowledgement, closing the output, or cancellation rejects its receipt. Ordinary provider streams retain their existing behavior.

SessionManager supports opt-in durable message append. A failed durable append does not publish a reusable entry and fences subsequent appends until recovery. Ordinary append behavior, session format v3, parsing, migration and navigation are unchanged. AgentSession applies the durability barrier to harness commits.

Harnesses receive existing read-only session identity and entry information. They do not install checkpoint indexes or new journal record types in SessionManager.

## Native continuation

Claude binds its native state to canonical boundaries in harness-owned storage. A fork at a completed tool result preserves the exchange and permits independent cold continuation of both branches without repeating the tool. Missing or mismatched native state fails explicitly; text replay is not exact continuation.

Claude carries genuine native API response IDs in the existing `AssistantMessage.responseId` field. A tool result locates that ID through its original call ID and the preceding canonical call. Native IDs identify checkpoint resources; a canonical-prefix fingerprint validates the selected boundary rather than guessing conversation identity. Normal v3 forks copy those references with their messages, including a fork exactly at a result, without new Pi metadata records or fork hooks.

Checkpoint publication is separate from canonical commit acknowledgement. A completed result is resumable only when the whole native tool batch is known and every included call/result has canonical and native coverage. Unresolved or partial batches do not acquire a resumable checkpoint. Intermediate output binds to the authoritative native frames it actually includes, not the most recently observed frame of any kind. Publication advances a certified native cursor and validates only the interval after that cursor. Boundaries retain canonical positions rather than copies of cumulative tool sets. The canonical fingerprint is built once per incoming history and continued through publication; final publication returns the checkpoint directly.

Cold continuation stages an opaque append-prefix cut under a fresh native session namespace. The native SDK interprets ancestry through `resumeSessionAt`; Pi does not maintain a parallel Claude ancestry graph. Source logs remain read-only to the new writer and can continue appending independently. Native child resources require their own cuts; the implementation refuses to flatten them into a parent-only continuation.

Native logs and checkpoint bindings live in Claude-owned storage at `agentDir/harness/claude` under the configured agent profile. Memory-only resources belong to the Pi session and are released by session-resource cleanup; a transient invocation without a session ID owns only its own resources. Cross-project forks in that profile retain access to the selected native state. Moving a session to another profile requires its native resources too; a canonical file alone does not claim exact continuation. Native metadata remains directly addressable and independent of warm processes.

The original rendering correction remains independent: the UI finalizes from stable committed snapshots, never from a cleared mutable partial.

## Maintenance boundary

No generic EventStream changes, session-format changes, new Pi journal records, migration changes or navigation rewrites are part of this integration. Any requirement that cannot fit those boundaries requires a new explicit decision. Current implementation gaps are in `harness-state.md`.
