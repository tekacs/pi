import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { Api, Model, Prepared } from "../types.ts";
import { type OpenAIResponsesStreamOptions, responseUsage } from "./openai-responses-shared.ts";

/** Preparation has no assistant stream: only an empty, completed provider response is success. */
export async function readPreparation<TApi extends Api>(
	events: AsyncIterable<ResponseStreamEvent>,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<Prepared> {
	for await (const event of events) {
		await options?.onProviderStreamEvent?.(event, model);
		if (event.type === "error") throw new Error(`Preparation failed: ${event.message}`);
		if (event.type === "response.failed" || event.type === "response.incomplete") {
			throw new Error(`Preparation did not complete: ${event.type}`);
		}
		if (
			event.type === "response.created" ||
			event.type === "response.in_progress" ||
			event.type === "response.queued"
		) {
			if (event.response.output?.length) throw new Error("Provider generated output during preparation");
			continue;
		}
		if (event.type !== "response.completed") throw new Error(`Unexpected preparation event: ${event.type}`);
		const response = event.response;
		if (response.id !== undefined && (typeof response.id !== "string" || response.id.length === 0)) {
			throw new Error("Preparation completed with an invalid response ID");
		}
		if (response.status !== "completed" || response.error)
			throw new Error("Preparation did not complete successfully");
		if (
			!Array.isArray(response.output) ||
			response.output.length !== 0 ||
			(response.usage?.output_tokens ?? 0) !== 0
		) {
			throw new Error("Preparation response contains output");
		}
		return { responseId: response.id, usage: responseUsage(response, model, options), reused: false };
	}
	throw new Error("Preparation stream ended before response.completed");
}
