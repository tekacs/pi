import type { AssistantMessage, ProviderFailure } from "../types.ts";

// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError extends ProviderFailure {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
	code?: unknown;
	type?: unknown;
};

/** Preserve raw-fetch and stream failure facts until the adapter settles its message. */
export class ProviderFailureError extends Error implements ProviderFailure {
	readonly status?: number;
	readonly code?: string;
	readonly type?: string;

	constructor(message: string, failure: ProviderFailure) {
		super(message);
		this.name = "ProviderFailureError";
		this.status = failure.status;
		this.code = failure.code;
		this.type = failure.type;
	}
}

/** Set the display and machine-readable failure together, without persisting raw SDK objects. */
export function setProviderError(
	output: Pick<AssistantMessage, "errorMessage" | "failure">,
	error: unknown,
	prefix?: string,
): asserts output is Pick<AssistantMessage, "errorMessage" | "failure"> & { errorMessage: string } {
	const normalized = normalizeProviderError(error);
	output.errorMessage = formatProviderError(normalized, prefix);
	const { status, code, type } = normalized;
	if (status === undefined && code === undefined && type === undefined) {
		delete output.failure;
		return;
	}
	output.failure = {
		...(status === undefined ? {} : { status }),
		...(code === undefined ? {} : { code }),
		...(type === undefined ? {} : { type }),
	};
}

function errorFields(value: unknown): { code?: string; type?: string } {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	if (typeof value !== "object" || value === null) return {};
	const record = value as Record<string, unknown>;
	return {
		...(typeof record.code === "string" && record.code ? { code: record.code } : {}),
		...(typeof record.type === "string" && record.type && record.type !== "error"
			? { type: record.type }
			: typeof record.status === "string" && record.status
				? { type: record.status }
				: {}),
	};
}

function bodyFields(value: unknown): { code?: string; type?: string } {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	// SDKs differ in whether error is the body, its error member, or a nested envelope.
	let fields = errorFields(value);
	for (let depth = 0; depth < 3 && typeof value === "object" && value !== null && "error" in value; depth++) {
		value = value.error;
		fields = { ...fields, ...errorFields(value) };
	}
	return fields;
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return {
			message: safeJsonStringify(error),
			messageCarriesBody: false,
			...(typeof error === "object" && error !== null ? { status: extractStatus(error as SdkErrorShape) } : {}),
			...bodyFields(error),
		};
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
		...(/Exception$/.test(error.name) ? { type: error.name } : {}),
		...bodyFields(error.message),
		...bodyFields(sdkError.$response?.body),
		...bodyFields(sdkError.body),
		...bodyFields(sdkError.error),
		...errorFields(sdkError),
	} satisfies NormalizedProviderError;
}

/**
 * Probe the HTTP error status (400–599), first valid hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	return [error.statusCode, error.status, error.$metadata?.httpStatusCode, error.$response?.statusCode].find(
		(status): status is number =>
			typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599,
	);
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
