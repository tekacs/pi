import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage, Model, ProviderFailure } from "../src/types.ts";
import { ProviderFailureError, setProviderError } from "../src/utils/error-body.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const opaque = '{"detail":"Unable to verify Daybreak Blue access. Please try again."}';
const queueExpiry =
	"We were unable to start processing your request within the 900-second timeout limit. Please try again later.";
const model: Model<"openai-codex-responses"> = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "test",
	name: "test",
	baseUrl: "https://provider.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.test`;
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };

function failed(failure?: ProviderFailure, errorMessage = opaque): AssistantMessage {
	return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), ...(failure ? { failure } : {}) };
}

function sse(event: unknown): Response {
	return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function success(): Response {
	return sse({ type: "response.completed", response: { id: "test", status: "completed", output: [] } });
}

function turn(fetch: typeof globalThis.fetch, maxRetries = 0) {
	return codexStream(model, context, { apiKey, transport: "sse", fetch, maxRetries }).result();
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// Regression for okou-ai/okou#35577 / PR #35819: status must survive opaque provider text.
describe("structured retry classification", () => {
	it.each([408, 409, 429, 500, 502, 503, 504, 520, 524, 529])("retries opaque HTTP %i", (status) => {
		expect(isRetryableAssistantError(failed({ status }))).toBe(true);
	});

	it.each([400, 401, 402, 403, 404, 413, 422])("does not let text override terminal HTTP %i", (status) => {
		expect(isRetryableAssistantError(failed({ status }, "503 overloaded, please retry your request"))).toBe(false);
	});

	it.each([
		"insufficient_quota",
		"usage_limit_reached",
		"invalid_api_key",
		"context_length_exceeded",
		"content_policy_violation",
		"model_not_found",
		"queue_timeout",
		"GoUsageLimitError",
	])("terminal code %s wins over 503 and transient type", (code) => {
		expect(isRetryableAssistantError(failed({ status: 503, code, type: "overloaded_error" }))).toBe(false);
	});

	it.each([queueExpiry, "billing subsystem offline", "429 quota exceeded", "Weekly usage limit reached"])(
		"terminal body wins: %s",
		(text) => {
			expect(isRetryableAssistantError(failed({ status: 503, code: "server_error" }, text))).toBe(false);
		},
	);

	it.each(["overloaded_error", "rate_limit_exceeded", "ThrottlingException", "ECONNRESET"])(
		"uses stream/transport code %s",
		(code) => {
			expect(isRetryableAssistantError(failed({ code }))).toBe(true);
		},
	);

	it("retains text fallback without treating diagnostics as authority", () => {
		expect(isRetryableAssistantError(failed(undefined, "connection refused"))).toBe(true);
		expect(isRetryableAssistantError(failed({ code: "future_code" }, "connection refused"))).toBe(true);
		expect(isRetryableAssistantError(failed())).toBe(false);
		expect(
			isRetryableAssistantError({
				...failed(),
				diagnostics: [
					{ type: "okou_model_request", timestamp: 1, details: { failureReason: "provider_server_error" } },
				],
			}),
		).toBe(false);
	});

	it("requires error settlement, not display text", () => {
		const message = failed({ status: 503 });
		delete message.errorMessage;
		expect(isRetryableAssistantError(message)).toBe(true);
		expect(isRetryableAssistantError({ ...message, stopReason: "aborted" })).toBe(false);
		expect(isRetryableAssistantError({ ...message, stopReason: "stop" })).toBe(false);
	});

	it("clears the old failure when aborted during backoff", async () => {
		const abort = new AbortController();
		const produce = vi.fn(async () => failed({ status: 503 }));
		const result = await retryAssistantCall(produce, policy, abort.signal, { onRetryScheduled: () => abort.abort() });
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBeUndefined();
		expect(result.failure).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
	});
});

describe("failure normalization", () => {
	it.each([
		Object.assign(new Error(opaque), { status: 503 }),
		Object.assign(new Error(opaque), { statusCode: 503 }),
		Object.assign(new Error(opaque), { $metadata: { httpStatusCode: 503 } }),
	])("preserves SDK status without changing display", (error) => {
		const message = failed();
		setProviderError(message, error);
		expect(message.failure).toEqual({ status: 503 });
		expect(message.errorMessage).toBe(opaque);
	});

	it.each([
		Object.assign(new Error("opaque"), { status: 429, error: { code: "insufficient_quota", type: "quota" } }),
		Object.assign(new Error("opaque"), {
			status: 429,
			body: JSON.stringify({ error: { code: "insufficient_quota", type: "quota" } }),
		}),
	])("retains provider code and type without raw objects", (error) => {
		const message = failed();
		setProviderError(message, error);
		expect(message.failure).toEqual({ status: 429, code: "insufficient_quota", type: "quota" });
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("unwraps Anthropic envelopes and preserves Bedrock exception names", () => {
		const message = failed();
		setProviderError(
			message,
			Object.assign(new Error("opaque"), { error: { type: "error", error: { type: "overloaded_error" } } }),
		);
		expect(message.failure).toEqual({ type: "overloaded_error" });
		setProviderError(message, Object.assign(new Error("opaque"), { name: "ThrottlingException" }));
		expect(message.failure).toEqual({ type: "ThrottlingException" });
		setProviderError(message, new Error("opaque"));
		expect(message.failure).toBeUndefined();
	});

	it("does not lose codes beyond the display truncation cap", () => {
		const message = failed();
		setProviderError(
			message,
			Object.assign(new Error("opaque"), {
				status: 503,
				body: JSON.stringify({ padding: "x".repeat(5000), error: { code: "invalid_api_key" } }),
			}),
		);
		expect(message.failure).toEqual({ status: 503, code: "invalid_api_key" });
		expect(isRetryableAssistantError(message)).toBe(false);
	});
});

describe("Codex request retry ownership", () => {
	it("keeps the default request budget at zero", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(opaque, { status: 503 }));
		const result = await codexStream(model, context, { apiKey, transport: "sse", fetch }).result();
		expect(result.failure).toEqual({ status: 503 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("still retries actual fetch failures when explicitly configured", async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockImplementation(async () => success());
		const pending = turn(fetch, 1);
		await vi.runAllTimersAsync();
		expect((await pending).stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("recovers from opaque 503 using only the turn budget", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(opaque, { status: 503 }))
			.mockImplementation(async () => success());
		const scheduled = vi.fn();
		const result = await retryAssistantCall(() => turn(fetch), policy, undefined, { onRetryScheduled: scheduled });
		expect(result.stopReason).toBe("stop");
		expect(result.failure).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(scheduled).toHaveBeenCalledTimes(1);
	});

	it("exhausts the turn budget and retains JSON-persistable failure facts", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(opaque, { status: 503 }));
		const result = await retryAssistantCall(() => turn(fetch), policy, undefined);
		expect(fetch).toHaveBeenCalledTimes(3);
		const restored = JSON.parse(JSON.stringify(result)) as AssistantMessage;
		expect(restored.failure).toEqual({ status: 503 });
		expect(restored.errorMessage).toBe(opaque);
		expect(isRetryableAssistantError(restored)).toBe(true);
	});

	it.each([
		{ status: 400, code: "bad_request", message: "try again" },
		{ status: 401, code: "invalid_api_key", message: "try again" },
		{ status: 402, code: "payment_required", message: "try again" },
		{ status: 429, code: "insufficient_quota", message: "no balance" },
		{ status: 429, code: "usage_limit_reached", message: "limit" },
		{ status: 503, code: "invalid_api_key", message: "try again" },
		{ status: 503, code: "server_error", message: queueExpiry },
		{ status: 503, code: "server_error", message: "billing subsystem offline" },
	])("does not replay terminal $code/$status at either retry layer", async ({ status, code, message }) => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(JSON.stringify({ error: { code, message } }), { status }),
		);
		const result = await retryAssistantCall(() => turn(fetch, 3), policy, undefined);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.failure).toMatchObject({ status, code });
	});

	it("distinguishes temporary 429 from account exhaustion", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
					status: 429,
				}),
		);
		const result = await turn(fetch);
		expect(result.errorMessage).toBe("slow down");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("honors an explicit request budget for transient HTTP errors", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response(opaque, { status: 503, headers: { "retry-after-ms": "0" } }))
			.mockImplementation(async () => success());
		expect((await turn(fetch, 1)).stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("does not turn observer exceptions into request retries", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
		const result = await codexStream(model, context, {
			apiKey,
			fetch,
			transport: "sse",
			maxRetries: 3,
			onResponse: () => {
				throw new Error("observer failed");
			},
		}).result();
		expect(result.errorMessage).toBe("observer failed");
		expect(result.failure).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["server_error", "invalid_api_key"])(
		"retains mid-stream code %s without assigning HTTP 200",
		async (code) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				sse({ type: "response.failed", response: { error: { code, message: "opaque" } } }),
			);
			const result = await turn(fetch);
			expect(result.failure).toEqual({ code });
			expect(isRetryableAssistantError(result)).toBe(code === "server_error");
		},
	);
});

describe("Codex WebSocket failures", () => {
	it("preserves transient and terminal codes without falling back to SSE", async () => {
		let code = "server_error";
		class Socket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send() {
				queueMicrotask(() =>
					this.dispatchEvent(
						new MessageEvent("message", {
							data: JSON.stringify({ type: "error", error: { code, message: "opaque" } }),
						}),
					),
				);
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", Socket);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
		for (const value of ["server_error", "invalid_api_key"]) {
			code = value;
			const result = await codexStream(model, context, { apiKey, transport: "websocket", fetch }).result();
			expect(result.failure).toEqual({ code });
			expect(isRetryableAssistantError(result)).toBe(code === "server_error");
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("shared SDK request guard", () => {
	it.each(["insufficient_quota", "invalid_api_key", "context_length_exceeded"])(
		"terminal %s overrides status and retry hint",
		async (code) => {
			const error = Object.assign(new ProviderFailureError("opaque", { status: 503, code }), {
				headers: new Headers({ "x-should-retry": "true" }),
			});
			const request = vi.fn(async () => {
				throw error;
			});
			await expect(retryProviderRequest(request, { maxRetries: 3 })).rejects.toBe(error);
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("retains terminal incomplete reasons through Responses settlement", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			sse({
				type: "response.incomplete",
				response: { status: "incomplete", output: [], incomplete_details: { reason: "content_filter" } },
			}),
		);
		const result = await responsesStream({ ...model, api: "openai-responses", provider: "openai" }, context, {
			apiKey: "sk-test",
			fetch,
		}).result();
		expect(result.failure).toEqual({ code: "content_filter" });
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("retains OpenAI Responses stream error codes", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			sse({
				type: "response.failed",
				response: { status: "failed", error: { code: "server_error", message: "opaque" } },
			}),
		);
		const result = await responsesStream({ ...model, api: "openai-responses", provider: "openai" }, context, {
			apiKey: "sk-test",
			fetch,
		}).result();
		expect(result.failure).toEqual({ code: "server_error" });
		expect(isRetryableAssistantError(result)).toBe(true);
	});
});
