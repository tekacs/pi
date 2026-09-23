import { describe, expect, it } from "vitest";
import { streamSimple as streamCodex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamCompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamFunction } from "../src/types.ts";

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;

interface CapturedPayload {
	input?: Record<string, unknown>[];
	messages?: Record<string, unknown>[];
	reasoning?: { effort?: string };
}

const refuse: typeof fetch = async () => {
	throw new Error("offline");
};

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

async function capture<TApi extends Api>(
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
	model: Model<TApi>,
	context: Context,
	reasoning: ThinkingLevel,
	apiKey = "test-key",
): Promise<{ payload: CapturedPayload; message: AssistantMessage }> {
	let payload: CapturedPayload | undefined;
	const message = await streamSimple(model, normalizeContext(context), {
		apiKey,
		reasoning,
		cacheRetention: "none",
		maxRetries: 0,
		fetch: refuse,
		transport: "sse",
		onPayload: (value) => {
			payload = structuredClone(value) as CapturedPayload;
			return undefined;
		},
	} as SimpleStreamOptions).result();
	if (!payload) throw new Error("Expected payload capture");
	return { payload, message };
}

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });

function assistant<TApi extends Api>(model: Model<TApi>, level: string | undefined, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		...(level === undefined ? {} : { providerThinkingLevel: level }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const responsesUpdate = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const completionsUpdate = (effort: string) => ({
	role: "system",
	content: "",
	configuration_update: { reasoning: { effort } },
});

function isUpdate(item: Record<string, unknown>): boolean {
	return item.type === "configuration_update" || item.configuration_update !== undefined;
}

function expectNoAdjacentUpdates(items: Record<string, unknown>[]): void {
	for (let index = 1; index < items.length; index++) {
		expect(isUpdate(items[index - 1]) && isUpdate(items[index])).toBe(false);
	}
}

const transports = [
	{
		name: "OpenAI Responses",
		model: () => getModel("openai", "gpt-6-astra") as Model<Api>,
		stream: streamResponses as StreamFunction<Api, SimpleStreamOptions>,
		items: (payload: CapturedPayload) => payload.input ?? [],
		update: responsesUpdate,
		apiKey: "test-key",
	},
	{
		name: "OpenAI Codex",
		model: () => getModel("openai-codex", "gpt-6-astra") as Model<Api>,
		stream: streamCodex as StreamFunction<Api, SimpleStreamOptions>,
		items: (payload: CapturedPayload) => payload.input ?? [],
		update: responsesUpdate,
		apiKey: codexToken(),
	},
	{
		name: "OpenRouter Chat Completions",
		model: () => getModel("openrouter", "openai/gpt-6-astra") as Model<Api>,
		stream: streamCompletions as StreamFunction<Api, SimpleStreamOptions>,
		items: (payload: CapturedPayload) => payload.messages ?? [],
		update: completionsUpdate,
		apiKey: "test-key",
	},
];

const conversation = <TApi extends Api>(model: Model<TApi>, levels: readonly string[]) =>
	levels.flatMap((level, index) => [user(`turn ${index}`, index), assistant(model, level, `answer ${index}`)]);

describe.each(transports)("$name mid-conversation effort", (transport) => {
	it("sends plain request-level effort while nothing is stamped", async () => {
		const model = transport.model();
		expect(model.compat).toMatchObject({ supportsMidConvoEffort: true });

		const { payload, message } = await capture(
			transport.stream,
			model,
			{ messages: [user("one", 1)] },
			"xhigh",
			transport.apiKey,
		);

		expect(payload.reasoning?.effort).toBe("xhigh");
		expect(transport.items(payload).filter(isUpdate)).toEqual([]);
		expect(message.providerThinkingLevel).toBe("xhigh");
	});

	it("keeps the first stamped effort as the baseline and replays changes in place", async () => {
		const model = transport.model();
		const request = (levels: readonly string[], reasoning: ThinkingLevel) =>
			capture(
				transport.stream,
				model,
				{ messages: [...conversation(model, levels), user(`turn ${levels.length}`, levels.length)] },
				reasoning,
				transport.apiKey,
			);

		// Each request's history is the previous request plus the response it produced.
		const steady = await request(["xhigh"], "xhigh");
		const lowered = await request(["xhigh", "xhigh"], "low");
		const held = await request(["xhigh", "xhigh", "low"], "low");
		const raised = await request(["xhigh", "xhigh", "low", "low"], "xhigh");

		const steadyItems = transport.items(steady.payload);
		const loweredItems = transport.items(lowered.payload);
		const heldItems = transport.items(held.payload);
		const raisedItems = transport.items(raised.payload);
		for (const payload of [steady, lowered, held, raised].map((result) => result.payload)) {
			expect(payload.reasoning?.effort).toBe("xhigh");
		}

		expect(steadyItems.filter(isUpdate)).toEqual([]);
		expect(loweredItems.at(-1)).toEqual(transport.update("low"));
		// A held effort adds nothing; the earlier change replays exactly where it was appended.
		expect(heldItems.slice(0, loweredItems.length)).toEqual(loweredItems);
		expect(heldItems.filter(isUpdate)).toEqual([transport.update("low")]);
		expect(raisedItems.slice(0, heldItems.length)).toEqual(heldItems);
		expect(raisedItems.filter(isUpdate)).toEqual([transport.update("low"), transport.update("xhigh")]);
		expect(raised.message.providerThinkingLevel).toBe("xhigh");
		expectNoAdjacentUpdates(raisedItems);
	});

	it("ignores stamps from other providers", async () => {
		const model = transport.model();
		const foreign = { ...assistant(model, "max", "foreign"), provider: "elsewhere" };
		const { payload } = await capture(
			transport.stream,
			model,
			{ messages: [user("one", 1), foreign, user("two", 2)] },
			"medium",
			transport.apiKey,
		);

		expect(payload.reasoning?.effort).toBe("medium");
		expect(transport.items(payload).filter(isUpdate)).toEqual([]);
	});
});

describe("unmanaged OpenAI models", () => {
	it("keep request-level effort and send no updates", async () => {
		const model = getModel("openai", "gpt-5.6-sol") as Model<Api>;
		expect(model.compat).not.toMatchObject({ supportsMidConvoEffort: true });

		const { payload, message } = await capture(
			streamResponses as StreamFunction<Api, SimpleStreamOptions>,
			model,
			{ messages: [user("one", 1)] },
			"xhigh",
		);

		expect(payload.reasoning?.effort).toBe("xhigh");
		expect((payload.input ?? []).filter(isUpdate)).toEqual([]);
		expect(message.providerThinkingLevel).toBeUndefined();
	});

	it("leaves pro and batch variants on OpenRouter unflagged", () => {
		for (const id of ["openai/gpt-6-astra-pro", "openai/gpt-6-astra:batch"]) {
			expect(getModel("openrouter", id as "openai/gpt-6-astra").compat).not.toMatchObject({
				supportsMidConvoEffort: true,
			});
		}
	});
});
