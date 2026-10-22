# Prompt caching and preparation

Prompt caching and preparation are separate operations. Cache controls describe which prefixes a normal request can reuse. Preparation sends known context without asking the model to generate an answer. Neither operation appends a conversation message or submits an agent turn.

## Cache boundaries

`StreamOptions.promptCache` selects modern OpenAI-style caching:

```ts
const options = {
  promptCache: { mode: "explicit", ttl: "30m" },
};

const context = {
  messages: [{
    role: "system",
    content: [
      { type: "text", text: "Stable reference material", cache: { ttl: "12h" } },
      { type: "text", text: "Session instructions", cache: { ttl: "30m" } },
    ],
    timestamp: 0,
  }],
};
```

A breakpoint ends a cumulative prefix, not an independently cached segment. The second marker includes the first block. A request-level TTL is a minimum for its breakpoints: use `30m` at request level when only the common prefix needs `12h`. `implicit` mode also permits the provider's automatic breakpoint; `explicit` mode does not.

Text and image input blocks carry `cache`. System-message replay preserves their boundaries and text order. Named system sections remain text following the content; put a boundary-bearing section in `content` rather than in `sections`. Tool results retain block order when marked. Chat Completions rejects marked tool results containing images because its tool-image conversion moves the images to a later user message. Assistant-output markers and markers on images that the model cannot accept are also rejected. Unmarked requests retain their existing encoding.

The Chat Completions and Responses adapters emit `prompt_cache_breakpoint` only when the model's `compat.supportsExplicitPromptCacheMode` is enabled. This capability describes the selected endpoint and model, not every service that accepts OpenAI-shaped requests. Modern controls do not change the legacy `cacheRetention` mapping. Do not combine a modern policy with legacy retention in the same request.

Cache keys and provider session IDs are not interchangeable. Preparation and the next request use the ordinary session ID and auth path. A shared prefix does not require replacing a session ID with a global identifier.

## Non-generation preparation

`Models.prepare()` and `Models.prepareSimple()` take the same context and request options as `stream()` and `streamSimple()`. They normalize context, resolve credentials, apply header transforms and invoke the ordinary provider request builder. Preparation returns a result with provider-reported usage and an optional response ID, not an assistant message or a stream of agent events.

The model declares the endpoint's preparation protocol in `compat.preparation`: `"cache"` selects Responses `prompt_cache_options.prewarm: true`; `"connection"` selects Codex WebSocket `generate: false`. Unset or `false` means unavailable. Cache preparation also requires `supportsExplicitPromptCacheMode`; Sign in with ChatGPT on the Responses endpoint is excluded. Connection preparation requires a session ID, enabled caching and a WebSocket transport. These declarations must describe the actual endpoint; selecting an OpenAI-shaped API is not a capability declaration.

Preparation never falls back to a token-generating request. In particular, OpenRouter's documented cache controls do not establish support for non-generation preparation. A custom `streamSimple` override without a native preparation operation is refused, not bypassed with the built-in generator. The existing CLI's timed one-token cache warmer remains a separate feature; this API does not invoke it.

The non-generation field is applied after `onPayload`, so a payload hook cannot accidentally turn preparation into generation. A provider response must complete without output before preparation succeeds. EOF, failure, incomplete status or generated output is an error; an accepted HTTP request alone is not completion.

For connection preparation, the existing session socket owner retains continuation state only after successful completion. A subsequent ordinary request can send an input delta only when its endpoint, credentials, handshake headers, non-input settings and complete earlier input prefix match. Otherwise it sends complete context. Preparation flags are operation controls, not generation settings. Omitted transport and explicit `"auto"` both enable this delta reuse, as does `"websocket-cached"`; plain `"websocket"` sends full input. Closing a connection discards its response-ID continuation; a cache TTL does not keep a socket alive.

Cancellation uses the ordinary `AbortSignal`. Await the preparation promise after aborting it to join cleanup. `await cleanupSessionResources(sessionId)` cancels and joins preparation, including request setup, and closes retained sockets. A payload hook that does not observe cancellation must return before that join can finish. Shared credential refresh retains its own auth-owner semantics; cancellation does not undo provider work or refund cache-write charges.

Connection preparation has one cancellation owner per session. Matching calls with the same original signal (or with no signal) join the pending operation. A different signal is refused while it is pending. The same owner can replace the request; replacement cancels and joins the earlier operation first. A healthy connection with the exact prepared prefix avoids another preparation request and reports `reused: true` without new usage. HTTP cache preparation sends one request per invocation.

An ordinary Codex request joins pending preparation when the connection identity, settings and prefix match; otherwise it cancels and joins preparation before sending complete context. Preparation does not start while an ordinary request is active. A failed preparation does not itself dispatch a generation; a separately requested ordinary turn can proceed with complete context.

## Usage and limits

Cache writes cost money even when preparation generates no output. Responses usage distinguishes ordinary input, cache reads, and cache writes. When the provider reports writes by lifetime, Pi calculates 30-minute writes at 1.25 times the input rate and 12-hour writes at 2.5 times that rate. It does not infer a lifetime split from local token estimates. When a modern endpoint omits lifetime counts, Pi prices those writes at the 2.5-times upper rate and sets `usage.cost.estimated: true`; it does not assign them a fabricated lifetime. This is a conservative estimate, not an invoice.

Preparation does not guarantee a later cache hit or lower latency. Prefix length, model and endpoint capabilities, routing, provider eviction and elapsed time still matter. Full explicit context remains the recovery path when a response ID cannot be reused.

Preparation state is not a portable snapshot. Transcript export/import or a conversation fork copies addressable history; it does not export provider KV state, an authenticated connection or a connection-local response ID.
