# Durable custom input admission

`pi.admitMessage(id, message, options?)` transfers a custom input to the session.
It returns the admission entry ID only after Pi has persisted and synced the
input. The session must be file-backed. A failed write throws and fences the
writer; no acceptance is returned.

The caller supplies a stable, namespaced receipt ID. The message contains
`customType`, `content`, `display`, and optional `details`. Pi retains this
immutable content under that ID. Reusing an ID with different content is an
error, not an update. The admission record belongs to the session that accepted
it; copying history into a new session ID or forking does not transfer pending
input ownership. A byte-for-byte copy retaining the session ID is the same
session, not a second independently owned session.

## Admission, delivery, and replay

Admission and delivery are different facts. Admission transfers custody to Pi;
it does not claim that a provider has read the message. Pi queues admitted input
at an ordinary safe boundary. The persisted custom message identifies its
admission request. Pi syncs that projection before recording it as delivered in
memory. Recovery rebuilds pending requests from the session's physical journal,
not solely from the currently selected branch.

Re-offering an outstanding receipt returns its existing admission. It neither
queues another copy nor restarts inference. Abort stops inference but retains
admitted input. A subsequent explicit prompt consumes retained input once.
Navigation likewise cannot create a second copy of an outstanding request.

When a receipt was already delivered, an offer returns its existing request if
that delivery is on the selected branch. If the selected branch does not contain
the delivery, an explicit offer records a new delivery request for the same
immutable receipt. Receipt identity and replay-request identity are therefore
separate. Navigation alone does not replay every historical input.

## Delivery through an executing tool

An admission may name `options.toolCallId` when the invoking tool's result will
carry this input. The tool must currently be executing. Its result includes the
returned admission entry ID in `details.inputIds: string[]`. Pi does not also
inject a custom message while that tool is running. Only a persisted result
matching both the tool call and admission entry ID fulfills the request; Pi
syncs that write. A result without the marker does not prove delivery. After a completed tool batch, Pi queues any unfulfilled input before the next
provider request, excluding calls still executing. It does not wait for the
whole agent run to settle. Abort still prevents automatic resumption.
A restart distinguishes a recorded tool result from an unfinished request.
Nested tool calls can admit input, but their unpersisted results do not fulfill
it. Copying a nested marker into a parent result does not change its call ID;
the input remains pending for ordinary delivery.

## Delivery authority

Custody does not grant delivery permission. An admission can name an immutable
`options.policy`. Its extension registers that name with
`pi.registerInputPolicy(name, { check, accept? })`. `check` receives the receipt
ID, request entry ID and immutable message, and returns `allow`, `hold` or
`cancel`. `accept` is synchronous: immediately before an automatic turn starts,
Pi invokes it for the permitted queued inputs so the source can bind attribution.
Checks do not themselves grant that attribution.
Pi treats a missing policy as `hold`. Recovery retains the same policy name;
restarting without the owning extension cannot authorize its pending input.

Pi checks the policy before queueing input or starting an automatic turn, and
checks it again before persisting a queued custom-message projection. A hold
removes a queued attempt but retains the durable request. Cancellation uses the
same durable cancellation operation as `cancelMessage`. A refusal throws no
acceptance away: Pi retains custody and reports the policy error.

`pi.refreshInputs()` notifies the admission owner that policy facts changed.
It does not reoffer receipts or grant permission. The owner reevaluates retained
requests; hold does not cause periodic polling. Abort remains independent:
reevaluation of existing input cannot itself undo an abort suspension.

A tool result carrying the exact request marker records delivery through that
explicit executing tool, rather than permission for a separate automatic turn.
An unfinished tool handoff must pass the policy before custom-message delivery.

## Cancellation and lifecycle

`pi.cancelMessage(id)` durably cancels outstanding input and removes its queued
copy. Cancellation does not erase a previously delivered message or affect the
external operation that produced the input. A cancelled ID cannot be admitted
again; a genuinely new input needs a new ID.

New admission may request inference; an idempotent repeat may not. Startup
recovers pending admissions after extensions have initialized. A startup handler
failure aborts initialization before admission recovery can enqueue or start
inference. Rebinding extensions does not undo an existing abort suspension. Queued input is
not exposed in the middle of a tool exchange. A source can release its own
receipt after `admitMessage` returns because Pi now owns the crash-recoverable
delivery obligation; source code does not inspect Pi's volatile queues or infer
admission from run settlement.
