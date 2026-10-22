import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { CacheBreakpoint, PromptCache, StreamOptions, TranscriptContext, Usage } from "../types.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Wire extension documented by OpenAI; the released SDK still restricts TTL to 30m. */
export type PromptCacheOptions = Omit<NonNullable<ResponseCreateParamsStreaming["prompt_cache_options"]>, "ttl"> & PromptCache;

export function hasCacheBreakpoints(context: TranscriptContext): boolean {
	return context.messages.some((message) =>
		Array.isArray(message.content) && message.content.some((block) => "cache" in block && block.cache !== undefined),
	);
}

/** Reject controls that the adapter cannot preserve before making a provider request. */
export function validatePromptCache(
	context: TranscriptContext,
	options: StreamOptions | undefined,
	supported: boolean,
): void {
	const marked = hasCacheBreakpoints(context);
	if (!marked && options?.promptCache === undefined) return;
	if (!supported) throw new Error("This model endpoint does not support explicit prompt cache controls");
	if (options?.cacheRetention !== undefined) {
		throw new Error("promptCache and cache breakpoints cannot be combined with cacheRetention");
	}
	const policy = options?.promptCache;
	if (policy?.mode !== undefined && policy.mode !== "implicit" && policy.mode !== "explicit") {
		throw new Error("Invalid prompt cache mode");
	}
	validateLifetime(policy);
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!("cache" in block) || block.cache === undefined) continue;
			if (message.role === "assistant") throw new Error("Cache breakpoints require input content");
			if (block.type === "text" && block.text.length === 0) throw new Error("Cache breakpoint text must not be empty");
			validateLifetime(block.cache);
		}
	}
}

function validateLifetime(value: { ttl?: string } | undefined): void {
	if (value?.ttl !== undefined && value.ttl !== "30m" && value.ttl !== "12h") {
		throw new Error("Invalid prompt cache lifetime");
	}
}

/** Keep the wire field in one place so all input codecs preserve the same boundary. */
export function cacheBreakpoint(block: { cache?: CacheBreakpoint }): {
	prompt_cache_breakpoint?: { mode: "explicit"; ttl?: "30m" | "12h" };
} {
	return block.cache === undefined ? {} : { prompt_cache_breakpoint: { mode: "explicit", ...block.cache } };
}

/** Normalize the documented lifetime split without counting writes twice. */
export function applyCacheWrites(usage: Usage, details: unknown, modern: boolean): void {
	if (details !== undefined) {
		if (details === null || typeof details !== "object") throw new Error("Invalid cache-write lifetime counts");
		const split = details as Record<string, unknown>;
		const short = split.ttl_30m_tokens;
		const long = split.ttl_12h_tokens;
		if (typeof short !== "number" || !Number.isSafeInteger(short) || short < 0 ||
			typeof long !== "number" || !Number.isSafeInteger(long) || long < 0 || short + long !== usage.cacheWrite) {
			throw new Error("Invalid cache-write lifetime counts");
		}
		usage.cacheWriteDetails = [
			{ tokens: short, ttlSeconds: 1800, inputMultiplier: 1.25 },
			{ tokens: long, ttlSeconds: 43200, inputMultiplier: 2.5 },
		];
	} else if (modern && usage.cacheWrite > 0) {
		// Do not invent a TTL split. Price the unknown writes at the upper rate and label the estimate.
		usage.cacheWriteDetails = [{ tokens: usage.cacheWrite, inputMultiplier: 2.5 }];
		usage.cost.estimated = true;
	}
}

/** SDK 7.x accepts the current wire shape at runtime but has not typed 12h yet. */
export function sdkPromptCache(policy: PromptCacheOptions | undefined): ResponseCreateParamsStreaming["prompt_cache_options"] {
	return policy as ResponseCreateParamsStreaming["prompt_cache_options"];
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
