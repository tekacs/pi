import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";
import type { Model, ProviderHeaders, TranscriptContext } from "../types.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	getDeclaredTools,
	getInitialSystemMessage,
	resolveTranscript,
	resolveTranscriptTools,
} from "../utils/transcript.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses.ts";
import { clampOpenAIPromptCacheKey, hasCacheBreakpoints, validatePromptCache } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, getResponsesToolSupport } from "./openai-responses-shared.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

export async function createRequest(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: OpenAICodexResponsesOptions,
) {
	options?.signal?.throwIfAborted();
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const accountId = extractAccountId(apiKey);
	const grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(normalizedContext.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	);
	const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
	let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties);
	const nextBody = await options?.onPayload?.(body, model);
	if (nextBody !== undefined) {
		body = nextBody as RequestBody;
	}
	const websocketRequestId = codexSessionId || uuidv7();
	// Codex expects an originator on every request; it is not attribution.
	const identityHeaders = { originator: "pi", ...getIdentityHeaders(model, options?.identity) };
	const sseHeaders = buildSSEHeaders(
		identityHeaders,
		model.headers,
		options?.headers,
		accountId,
		apiKey,
		codexSessionId,
	);
	const websocketHeaders = buildWebSocketHeaders(
		identityHeaders,
		model.headers,
		options?.headers,
		accountId,
		apiKey,
		websocketRequestId,
	);
	options?.signal?.throwIfAborted();
	// Continuation must describe the bytes sent, not an object a payload hook can later mutate.
	body = JSON.parse(JSON.stringify(body)) as RequestBody;
	return { body, accountId, grammarToolInputProperties, cacheSessionId, sseHeaders, websocketHeaders };
}

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
): RequestBody {
	validatePromptCache(context, options, model.compat?.supportsExplicitPromptCacheMode ?? false);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const markedInstructions =
		Array.isArray(initialSystemMessage?.content) &&
		initialSystemMessage.content.some((block) => block.cache !== undefined);
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools,
			supportsToolSearch,
		}),
	);
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: markedInstructions,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
	});

	const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: markedInstructions ? "" : instructions || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		prompt_cache_options: options?.promptCache ?? (hasCacheBreakpoints(context) ? {} : undefined),
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		body.tools = convertResponsesTools(transcriptTools.requestTools, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		});
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? model.thinkingLevelMap?.off === undefined
					? "none"
					: model.thinkingLevelMap.off
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	return body;
}

export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildBaseCodexHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	// Defaults first so model and caller headers can override them, matching the other providers.
	const headers = new Headers(defaultHeaders);
	for (const [key, value] of Object.entries(initHeaders || {})) {
		headers.set(key, value);
	}
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	return headers;
}

function buildSSEHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	defaultHeaders: Record<string, string>,
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
