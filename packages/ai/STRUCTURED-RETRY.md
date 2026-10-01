# Structured provider failures (fork patch)

This fork preserves provider failure facts on `AssistantMessage.failure`: HTTP
`status`, provider `code`, and provider `type`, when known. These are JSON data,
not a cached retry verdict. `errorMessage` remains the human-readable explanation;
diagnostics remain supplementary observations and never authorize retries.

Provider adapters retain facts before formatting HTTP or stream errors. The
shared classifier rejects aborts and known terminal conditions (credentials,
billing/account exhaustion, invalid requests, context/output limits, safety
refusals, and provider queue expiry) before accepting transient codes or statuses.
Known non-transient HTTP failures cannot be overridden by retry-looking text.
Unknown codes and failures without structured evidence retain text fallback.
A successful HTTP handshake is not the status of a later stream failure.

Codex distinguishes temporary throttling from account limits. Its optional
request retries use the shared classification, and only fetch exceptions enter
the network retry path. Observer failures are not network failures. The default
transport retry budget remains zero; session policy owns turn retries.

All chat adapters use the common failure representation. SDK-provided HTTP and
stream metadata are retained when exposed; missing facts are not guessed.
Messages preserve this data through JSON persistence. Abort during retry backoff
clears both the prior error text and its failure facts.

## Removal

Remove this fork patch **wholesale** when upstream provides equivalent structured
failure propagation and retry classification. Do not preserve this representation
as a compatibility layer beside upstream's replacement. The regression matrix is
the replacement criterion: opaque 503 recovery and exhaustion, terminal conditions
behind transient statuses, transient versus account-limit 429s, Codex transport
attempt counts, stream error codes, and persistence. Adding error-text patterns
alone is not an equivalent upstream fix.

Motivation: https://github.com/okou-ai/okou/pull/35819 (incident #35577). This is a
native pi-ai implementation, not a consumer of Okou's runtime diagnostics.

## State

No known implementation gaps within this contract. Unknown provider codes and
opaque mid-stream failures still use the documented text fallback; this patch
does not invent a transient classification without evidence.

Verified locally:
- 205 tests across 16 pi-ai suites, including structured failures, all chat
  adapters, existing transport retries, provider-error formatting and Codex streams.
- 8 coding-agent session/compaction tests, including actual turn retry events,
  budget exhaustion, terminal failures and JSON-preserved failure metadata.
- Full `npm run check`, including TypeScript, dependency/import/entry-graph checks,
  lockfile consistency and browser smoke.

The test runs unset `PI_CACHE_RETENTION` to exclude the invoking session's cache
policy. The repository check uses installed npm 11.12.1 (older npm 11.9.0 warns
about the repository's `min-release-age` setting). No provider network calls or
paid tokens are used. This verifies source; it does not install or reload Pi.
