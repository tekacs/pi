import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import * as codex from "../src/api/openai-codex-responses.ts";
import { createModels, createProvider } from "../src/models.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Context, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { barrier, model, Socket, token } from "./codex-socket.ts";

const context: Context = { messages: [{ role: "user", content: "Prefix", timestamp: 0 }] };
const options: StreamOptions = {
	apiKey: token(),
	sessionId: "example",
	transport: "websocket-cached",
	env: {},
	fetch: async () => {
		throw new Error("No HTTP fallback allowed");
	},
};

beforeEach(() => {
	vi.stubGlobal("WebSocket", Socket);
});
afterEach(async () => {
	await cleanupSessionResources("example");
	codex.resetOpenAICodexWebSocketDebugStats();
	Socket.reset();
	vi.unstubAllGlobals();
});

function models() {
	const collection = createModels();
	collection.setProvider(
		createProvider({
			id: "example",
			models: [model],
			api: openAICodexResponsesApi(),
			auth: { apiKey: { name: "Example", resolve: async () => ({ auth: { apiKey: token() }, source: "example" }) } },
		}),
	);
	return collection;
}

describe("native Codex preparation", () => {
	it.each<StreamOptions["transport"]>([undefined, "auto", "websocket-cached"])(
		"uses the ordinary builder and continues with only new input using transport %s",
		async (transport) => {
			const collection = models();
			const settings = { ...options, transport };
			const prepared = await collection.prepareSimple(model, context, settings);
			expect(prepared).toMatchObject({ responseId: "response-1", reused: false });
			expect(Socket.instances[0]?.requests[0]).toMatchObject({
				type: "response.create",
				generate: false,
				store: false,
				input: [{ role: "user", content: [{ type: "input_text", text: "Prefix" }] }],
			});
			const output = await collection.completeSimple(
				model,
				{ messages: [...context.messages, { role: "user", content: "Next", timestamp: 1 }] },
				settings,
			);
			expect(output.stopReason).toBe("stop");
			expect(Socket.instances).toHaveLength(1);
			expect(Socket.instances[0]?.requests[1]).toMatchObject({
				previous_response_id: "response-1",
				input: [{ role: "user", content: [{ type: "input_text", text: "Next" }] }],
			});
			expect(Socket.instances[0]?.requests[1]).not.toHaveProperty("generate");
			expect(codex.getOpenAICodexWebSocketDebugStats("example")).toMatchObject({
				preparations: 1,
				requests: 2,
				connectionsCreated: 1,
				connectionsReused: 1,
				deltaRequests: 1,
			});
			expect(context.messages).toHaveLength(1);
		},
	);

	it("joins duplicate preparation by the same owner and skips a matching healthy prefix afterward", async () => {
		const sent = barrier();
		Socket.onSend = () => sent.resolve();
		const collection = models();
		const first = collection.prepare(model, context, options);
		await sent.promise;
		const entered = barrier();
		const second = collection.prepare(model, context, { ...options, onPayload: () => entered.resolve() });
		await entered.promise;
		Socket.instances[0]!.complete();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(secondResult).toBe(firstResult);
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0]?.requests).toHaveLength(1);
		const reused = await collection.prepare(model, context, options);
		expect(reused).toEqual({ responseId: "response-1", reused: true });
		expect(Socket.instances[0]?.requests).toHaveLength(1);
	});

	it("cancels and joins the same owner's earlier preparation before replacing it", async () => {
		const sent = barrier();
		const owner = new AbortController();
		Socket.onSend = () => sent.resolve();
		const first = models()
			.prepare(model, context, { ...options, signal: owner.signal })
			.catch((error: unknown) => error);
		await sent.promise;
		Socket.onSend = (socket) => {
			expect(Socket.instances[0]?.readyState).toBe(3);
			socket.complete();
		};
		const next = await models().prepare(model, context, { ...options, signal: owner.signal, temperature: 0.5 });
		expect(await first).toBeInstanceOf(Error);
		expect(next.reused).toBe(false);
		expect(Socket.instances).toHaveLength(2);
		expect(Socket.instances[1]?.requests[0]).toMatchObject({ generate: false, temperature: 0.5 });
		expect(Socket.instances[1]?.requests[0]?.previous_response_id).toBeUndefined();
	});

	it("cancels and joins preparation when the waiting ordinary request is aborted", async () => {
		const sent = barrier();
		Socket.onSend = () => sent.resolve();
		const task = codex.prepare(model, normalizeContext(context), options).catch((error: unknown) => error);
		await sent.promise;
		const owner = new AbortController();
		const generation = codex.stream(model, normalizeContext(context), { ...options, signal: owner.signal });
		// Let ordinary setup finish and join the pending preparation before cancellation.
		await new Promise<void>((resolve) => setImmediate(resolve));
		owner.abort();
		expect((await generation.result()).stopReason).toBe("aborted");
		expect(await task).toBeInstanceOf(Error);
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0]?.requests).toHaveLength(1);
		expect(Socket.instances[0]?.readyState).toBe(3);
	});

	it("cannot let a payload hook re-enable generation", async () => {
		await codex.prepare(model, normalizeContext(context), {
			...options,
			onPayload: (payload) => ({ ...(payload as object), generate: true, type: "wrong" }),
		});
		expect(Socket.instances[0]?.requests[0]).toMatchObject({ generate: false, type: "response.create" });
	});

	it("joins an in-flight preparation before the ordinary request acquires its connection", async () => {
		const sent = barrier();
		Socket.onSend = (socket, request) => (request.generate === false ? sent.resolve() : socket.complete());
		const task = codex.prepare(model, normalizeContext(context), options);
		await sent.promise;
		const stream = codex.stream(model, normalizeContext(context), options);
		Socket.instances[0]!.complete();
		await task;
		expect((await stream.result()).stopReason).toBe("stop");
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0]?.requests[1]).toMatchObject({ previous_response_id: "response-1", input: [] });
	});

	it.each<StreamOptions>([{ temperature: 0.5 }, { cacheRetention: "none" }])(
		"cancels and joins a mismatched preparation before a real request starts: %j",
		async (changed) => {
			const sent = barrier();
			Socket.onSend = (socket, request) => (request.generate === false ? sent.resolve() : socket.complete());
			const task = codex.prepare(model, normalizeContext(context), options).catch((error: unknown) => error);
			await sent.promise;
			const output = await codex.stream(model, normalizeContext(context), { ...options, ...changed }).result();
			expect(await task).toBeInstanceOf(Error);
			expect(output.stopReason).toBe("stop");
			expect(Socket.instances).toHaveLength(2);
			expect(Socket.instances[0]?.readyState).toBe(3);
			expect(Socket.instances[1]?.requests[0]?.previous_response_id).toBeUndefined();
		},
	);

	it("does not interrupt another cancellation owner or an active generation", async () => {
		const sent = barrier();
		Socket.onSend = () => sent.resolve();
		const owner = new AbortController();
		const task = codex
			.prepare(model, normalizeContext(context), { ...options, signal: owner.signal })
			.catch((error: unknown) => error);
		await sent.promise;
		await expect(
			codex.prepare(model, normalizeContext(context), { ...options, signal: new AbortController().signal }),
		).rejects.toThrow("another cancellation owner");
		expect(Socket.instances[0]?.readyState).toBe(1);
		owner.abort();
		expect(await task).toBeInstanceOf(Error);
		const generation = new AbortController();
		const stream = codex.stream(model, normalizeContext(context), { ...options, signal: generation.signal });
		await expect(codex.prepare(model, normalizeContext(context), options)).rejects.toThrow("active session request");
		generation.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
	});

	it.each([
		{ status: "incomplete" },
		{ status: "failed" },
		{ output: [{ type: "message" }] },
		{ id: "" },
		{ id: 42 },
		{ id: {} },
		{ output: undefined },
		{ usage: { output_tokens: 1 } },
	])("does not retain unsuccessful preparation %j", async (response) => {
		Socket.onSend = (socket) => socket.complete(response);
		await expect(codex.prepare(model, normalizeContext(context), options)).rejects.toThrow();
		expect(Socket.instances[0]?.readyState).toBe(3);
		Socket.onSend = undefined;
		expect((await codex.stream(model, normalizeContext(context), options).result()).stopReason).toBe("stop");
		expect(Socket.instances[1]?.requests[0]?.previous_response_id).toBeUndefined();
	});

	it("fails on output events and premature close rather than falling back to HTTP", async () => {
		Socket.onSend = (socket) => socket.emit({ type: "response.output_text.delta", delta: "not preparation" });
		await expect(codex.prepare(model, normalizeContext(context), options)).rejects.toThrow(
			"Unexpected preparation event",
		);
		Socket.onSend = (socket) => socket.close();
		await expect(codex.prepare(model, normalizeContext(context), options)).rejects.toThrow();
		expect(Socket.instances.every((socket) => socket.readyState === 3)).toBe(true);
	});

	it("session cleanup joins payload setup and prevents late socket creation", async () => {
		const entered = barrier();
		const release = barrier();
		const task = models()
			.prepare(model, context, {
				...options,
				onPayload: async () => {
					entered.resolve();
					await release.promise;
				},
			})
			.catch((error: unknown) => error);
		await entered.promise;
		let closed = false;
		const close = cleanupSessionResources("example").then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await close;
		expect(await task).toBeInstanceOf(Error);
		expect(Socket.instances).toHaveLength(0);
	});

	it("session cleanup cancels and joins an outstanding socket request", async () => {
		const sent = barrier();
		Socket.onSend = () => sent.resolve();
		const task = models()
			.prepare(model, context, options)
			.catch((error: unknown) => error);
		await sent.promise;
		await cleanupSessionResources("example");
		expect(await task).toBeInstanceOf(Error);
		expect(Socket.instances[0]?.readyState).toBe(3);
	});

	it("cleans up only the addressed session", async () => {
		const sent = barrier();
		const sockets = new Map<string, Socket>();
		Socket.onSend = (socket, request) => {
			sockets.set(String(request.prompt_cache_key), socket);
			if (sockets.size === 2) sent.resolve();
		};
		const first = codex.prepare(model, normalizeContext(context), options).catch((error: unknown) => error);
		const other = codex.prepare(model, normalizeContext(context), { ...options, sessionId: "other" });
		try {
			await sent.promise;
			await cleanupSessionResources("example");
			expect(await first).toBeInstanceOf(Error);
			expect(sockets.get("example")?.readyState).toBe(3);
			expect(sockets.get("other")?.readyState).toBe(1);
			sockets.get("other")!.complete();
			expect((await other).reused).toBe(false);
		} finally {
			await cleanupSessionResources("other");
		}
	});

	it("refuses unadvertised preparation and SSE without a provider request", async () => {
		await expect(codex.prepare({ ...model, compat: {} }, normalizeContext(context), options)).rejects.toThrow(
			"does not support",
		);
		await expect(codex.prepare(model, normalizeContext(context), { ...options, transport: "sse" })).rejects.toThrow(
			"WebSocket session",
		);
		expect(Socket.instances).toHaveLength(0);
	});
});
