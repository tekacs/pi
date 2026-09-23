// Mid-conversation reasoning effort for OpenAI models that accept `configuration_update`.
//
// Request-level effort stays at the conversation's baseline: the effort of its first stamped
// response, or the requested effort when nothing is stamped yet. A conversation that never
// changes effort therefore sends plain request-level effort and no updates. When the requested
// effort differs from the one in effect, an update item is appended to the end of the input,
// and each response is stamped with the effort it ran at (`providerThinkingLevel`). On replay,
// the converters re-insert an update directly before every stamped response whose effort
// differs from the one in effect, which is exactly where the original request appended it.
// Updates are therefore never adjacent and the replayed input is byte-identical.
//
// OpenAI Responses (and the Codex backend) take a `configuration_update` input item.
// OpenRouter Chat Completions takes `configuration_update` on a content-less system message.

type EffortReasoning = { effort?: string | null } | null | undefined;
type EffortModel = { provider: string; api: string };
type TranscriptEntry = { role: string; provider?: string; api?: string; providerThinkingLevel?: string };

/** `configuration_update` input item for OpenAI Responses. */
export function responsesEffortUpdate(effort: string) {
	return { type: "configuration_update" as const, reasoning: { effort } };
}

/** OpenRouter Chat Completions form: a content-less system message carrying the update. */
export function completionsEffortUpdate(effort: string) {
	return { role: "system" as const, content: "", configuration_update: { reasoning: { effort } } };
}

/** Effort a response from this provider and API was stamped with. */
export function getStampedEffort(message: TranscriptEntry, model: EffortModel): string | undefined {
	if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api) {
		return undefined;
	}
	return message.providerThinkingLevel;
}

/** The conversation's request-level effort: its first stamped response, if any. */
export function getMidConvoBaseline(messages: readonly TranscriptEntry[], model: EffortModel): string | undefined {
	for (const message of messages) {
		const effort = getStampedEffort(message, model);
		if (effort !== undefined) return effort;
	}
	return undefined;
}

function readEffortUpdate(item: unknown): string | undefined {
	const candidate = item as {
		type?: unknown;
		reasoning?: { effort?: string };
		configuration_update?: { reasoning?: { effort?: string } };
	};
	if (candidate.type === "configuration_update") return candidate.reasoning?.effort;
	return candidate.configuration_update?.reasoning?.effort;
}

/** Effort in effect at the end of `items`: the last update, else the request-level effort. */
function getEffortInEffect(items: readonly unknown[], requestEffort: string): string {
	for (let index = items.length - 1; index >= 0; index--) {
		const effort = readEffortUpdate(items[index]);
		if (effort !== undefined) return effort;
	}
	return requestEffort;
}

/**
 * Holds request-level effort at the baseline and appends an update when the requested
 * effort differs from the one already in effect.
 */
export function pinMidConvoEffort(
	items: unknown[],
	reasoning: EffortReasoning,
	baseline: string | undefined,
	update: (effort: string) => unknown,
): void {
	const effort = reasoning?.effort;
	if (!reasoning || !effort) return;
	const requestEffort = baseline ?? effort;
	if (effort !== getEffortInEffect(items, requestEffort)) items.push(update(effort));
	reasoning.effort = requestEffort;
}

/** Effort a pinned request runs at, or undefined when it carries no reasoning config. */
export function getMidConvoEffort(items: unknown, reasoning: EffortReasoning): string | undefined {
	if (!reasoning?.effort || !Array.isArray(items)) return undefined;
	return getEffortInEffect(items, reasoning.effort);
}
