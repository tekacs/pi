import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { type CombinedAbortSignal, combineAbortSignals } from "../utils/abort-signals.ts";
import { OutputAnsiNormalizer } from "../utils/ansi-sgr.ts";
import { ProviderFailureError, StreamStalledError, setProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import {
	applyGoogleServiceTierPricing,
	convertMessages,
	convertTools,
	createGoogleGenAI,
	GooglePartialArgsStream,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export { StreamStalledError };

/** Default per-chunk idle watchdog for Google Vertex SSE streams (60 seconds). */
export const DEFAULT_VERTEX_STREAM_STALL_TIMEOUT_MS = 60_000;

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleApiThinkingLevel;
	};
	project?: string;
	location?: string;
	/**
	 * Per-chunk idle watchdog timeout in milliseconds after HTTP response headers are received.
	 * If no SSE frame arrives within this window, the stalled fetch is aborted with a retryable
	 * {@link StreamStalledError}. Set to `0` to disable. Defaults to
	 * `PI_VERTEX_STREAM_STALL_TIMEOUT_MS` or {@link DEFAULT_VERTEX_STREAM_STALL_TIMEOUT_MS} (60s).
	 */
	streamStallTimeoutMs?: number;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		const stallController = new AbortController();
		let combinedSignal: CombinedAbortSignal = {
			signal: options?.signal,
			cleanup: () => {},
		};

		try {
			const streamStallTimeoutMs = resolveStreamStallTimeoutMs(options);
			if (streamStallTimeoutMs > 0) {
				combinedSignal = combineAbortSignals([options?.signal, stallController.signal]);
			}
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			}
			const apiKey = resolveApiKey(options);
			const sessionAffinityId = resolveSessionAffinityId(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers, options?.identity, sessionAffinityId)
				: createClient(
						model,
						resolveProject(options),
						resolveLocation(options),
						options?.headers,
						options?.env,
						options?.identity,
						sessionAffinityId,
					);
			const currentTools = getCurrentTools(normalizedContext.messages);
			const paramsOptions =
				combinedSignal.signal === options?.signal ? options : { ...options, signal: combinedSignal.signal };
			let params = buildParams(model, normalizedContext, paramsOptions);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			let currentTextNormalizer: OutputAnsiNormalizer | null = null;
			let openToolCall: {
				toolCall: ToolCall;
				contentIndex: number;
				partialArgs: GooglePartialArgsStream;
				hasReceivedChunks: boolean;
			} | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			const closeCurrentBlock = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					const tail = currentTextNormalizer?.flush() ?? "";
					if (tail.length > 0) {
						currentBlock.text += tail;
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: tail,
							partial: output,
						});
					}
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
					currentTextNormalizer?.reset();
					currentTextNormalizer = null;
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
				currentBlock = null;
			};
			const finishOpenToolCall = () => {
				if (!openToolCall) return;
				const { toolCall, contentIndex, partialArgs } = openToolCall;
				openToolCall = null;
				const finished = partialArgs.finish();
				toolCall.arguments = finished.arguments;
				if (finished.delta.length > 0) {
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: finished.delta,
						partial: output,
					});
				}
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			};
			for await (const chunk of iterateWithIdleWatchdog(
				googleStream,
				streamStallTimeoutMs,
				(stallError) => stallController.abort(stallError),
				options?.signal,
			)) {
				await options?.onProviderStreamEvent?.(chunk, model);
				// Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
				// responseId is documented there as an output-only identifier for each response.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								closeCurrentBlock();
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									currentTextNormalizer = new OutputAnsiNormalizer({ healBareSgr: true });
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								const normalizedText = currentTextNormalizer!.push(part.text);
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								if (normalizedText.length > 0) {
									currentBlock.text += normalizedText;
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: normalizedText,
										partial: output,
									});
								}
							}
						}

						if (part.functionCall) {
							closeCurrentBlock();

							const fc = part.functionCall;
							const isStreamedChunk =
								openToolCall !== null || fc.willContinue === true || fc.partialArgs !== undefined;

							if (!isStreamedChunk) {
								const providedId = fc.id;
								const needsNewId =
									!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId ? `${fc.name}_${Date.now()}_${++toolCallCounter}` : providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: fc.name || "",
									arguments: (fc.args as Record<string, any>) ?? {},
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
							} else {
								if (
									openToolCall &&
									((fc.name && openToolCall.toolCall.name && fc.name !== openToolCall.toolCall.name) ||
										(fc.id && openToolCall.toolCall.id && fc.id !== openToolCall.toolCall.id) ||
										(fc.name && openToolCall.hasReceivedChunks))
								) {
									finishOpenToolCall();
								}

								if (!openToolCall) {
									const providedId = fc.id;
									const needsNewId =
										!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
									const toolCallId = needsNewId
										? `${fc.name || "tool"}_${Date.now()}_${++toolCallCounter}`
										: providedId;
									const toolName: string = fc.name || "";
									const toolSchema: unknown = currentTools.find((t) => t.name === toolName)?.parameters;
									const initialArgs = (fc.args as Record<string, any>) ?? {};
									const toolCall: ToolCall = {
										type: "toolCall",
										id: toolCallId,
										name: toolName,
										arguments: initialArgs,
										...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
									};
									output.content.push(toolCall);
									const contentIndex = blockIndex();
									openToolCall = {
										toolCall,
										contentIndex,
										partialArgs: new GooglePartialArgsStream(toolSchema, initialArgs),
										hasReceivedChunks: false,
									};
									stream.push({ type: "toolcall_start", contentIndex, partial: output });
								} else {
									if (!openToolCall.toolCall.name && fc.name) {
										openToolCall.toolCall.name = fc.name;
										openToolCall.partialArgs.setSchema(
											currentTools.find((t) => t.name === fc.name)?.parameters,
										);
									}
									const retainedSig = retainThoughtSignature(
										openToolCall.toolCall.thoughtSignature,
										part.thoughtSignature,
									);
									if (retainedSig) {
										openToolCall.toolCall.thoughtSignature = retainedSig;
									}
								}

								openToolCall.hasReceivedChunks = true;
								if (fc.partialArgs && fc.partialArgs.length > 0) {
									const { delta, arguments: nextArgs } = openToolCall.partialArgs.append(fc.partialArgs);
									openToolCall.toolCall.arguments = nextArgs;
									if (delta.length > 0) {
										stream.push({
											type: "toolcall_delta",
											contentIndex: openToolCall.contentIndex,
											delta,
											partial: output,
										});
									}
								}

								if (!fc.willContinue) {
									finishOpenToolCall();
								}
							}
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
					applyGoogleServiceTierPricing(output.usage, chunk.usageMetadata, params.config);
				}
			}

			closeCurrentBlock();

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (openToolCall) {
				if (output.stopReason === "length") {
					finishOpenToolCall();
				} else {
					throw new Error("Google Vertex stream ended with an incomplete function call");
				}
			}

			if (output.stopReason === "pending") {
				throw new Error("Google Vertex stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new ProviderFailureError(errorMessage, output.rawStopReason ? { type: output.rawStopReason } : {});
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			setProviderError(output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			combinedSignal.cleanup();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies GoogleVertexOptions;
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: toGoogleThinkingLevel(resolvedLevel),
			},
		} satisfies GoogleVertexOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
	identity?: ClientIdentity,
	sessionAffinityId?: string,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);
	return createGoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders, identity, sessionAffinityId),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	sessionAffinityId?: string,
): GoogleGenAI {
	return createGoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders, identity, sessionAffinityId),
	});
}

function resolveSessionAffinityId(options?: GoogleVertexOptions): string | undefined {
	const retention = options?.cacheRetention ?? getProviderEnvValue("PI_CACHE_RETENTION", options?.env);
	if (retention === "none") {
		return undefined;
	}
	const sessionId = (options?.cacheKey ?? options?.sessionId)?.trim();
	return sessionId ? sessionId : undefined;
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	sessionAffinityId?: string,
): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	const sessionHeaders = sessionAffinityId ? { "X-Vertex-Ai-Session-Id": sessionAffinityId } : undefined;
	const headers = providerHeadersToRecord(
		getIdentityHeaders(model, identity),
		sessionHeaders,
		model.headers,
		optionsHeaders,
	);
	if (headers) {
		httpOptions.headers = headers;
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const streamFunctionCallArguments = currentTools.length > 0 && supportsStrictMode;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		...(streamFunctionCallArguments && {
			automaticFunctionCalling: { disable: true },
		}),
		...((functionCallingMode !== undefined || streamFunctionCallArguments) && {
			toolConfig: {
				functionCallingConfig: {
					...(functionCallingMode !== undefined && { mode: functionCallingMode }),
					...(streamFunctionCallArguments && { streamFunctionCallArguments: true }),
				},
			},
		}),
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

function getGoogleBudget(
	model: Model<"google-vertex">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const budgetLevel: keyof ThinkingBudgets = level === "xhigh" ? "high" : level;
	if (customBudgets?.[budgetLevel] !== undefined) {
		return customBudgets[budgetLevel]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<keyof ThinkingBudgets, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[budgetLevel];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<keyof ThinkingBudgets, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[budgetLevel];
	}

	return -1;
}

function resolveStreamStallTimeoutMs(options?: GoogleVertexOptions): number {
	if (options?.streamStallTimeoutMs !== undefined) {
		if (!Number.isFinite(options.streamStallTimeoutMs) || options.streamStallTimeoutMs < 0) {
			throw new Error(`Invalid streamStallTimeoutMs: ${String(options.streamStallTimeoutMs)}`);
		}
		return Math.floor(options.streamStallTimeoutMs);
	}
	const envValue = getProviderEnvValue("PI_VERTEX_STREAM_STALL_TIMEOUT_MS", options?.env);
	if (envValue !== undefined) {
		const trimmed = envValue.trim();
		if (trimmed.length > 0) {
			const parsed = Number(trimmed);
			if (Number.isFinite(parsed) && parsed >= 0) {
				return Math.floor(parsed);
			}
		}
	}
	return DEFAULT_VERTEX_STREAM_STALL_TIMEOUT_MS;
}

async function* iterateWithIdleWatchdog<T>(
	iterable: AsyncIterable<T>,
	timeoutMs: number,
	onStall: (error: StreamStalledError) => void,
	callerSignal?: AbortSignal,
): AsyncGenerator<T> {
	if (timeoutMs <= 0) {
		yield* iterable;
		return;
	}
	const iterator = iterable[Symbol.asyncIterator]();
	let stalledError: StreamStalledError | undefined;
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const nextPromise = iterator.next();
			const stallPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					stalledError = new StreamStalledError(
						timeoutMs,
						`Google Vertex stream stalled after ${timeoutMs}ms without receiving data`,
					);
					onStall(stalledError);
					reject(stalledError);
				}, timeoutMs);
				timer.unref?.();
			});
			let result: IteratorResult<T>;
			try {
				result = await Promise.race([nextPromise, stallPromise]);
			} catch (error) {
				// Avoid unhandled rejection if the underlying read rejects after stallPromise already won.
				nextPromise.catch(() => {});
				if (stalledError && !callerSignal?.aborted) {
					throw stalledError;
				}
				throw error;
			} finally {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			}
			if (result.done) {
				return;
			}
			yield result.value;
		}
	} finally {
		if (stalledError) {
			void iterator.return?.().catch(() => {});
		} else {
			await iterator.return?.().catch(() => {});
		}
	}
}
