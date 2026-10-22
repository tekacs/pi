import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

import { model, Socket, token } from "./codex-socket.ts";

async function request(options: StreamOptions = {}, selected = model) {
	return stream(selected, normalizeContext({ messages: [{ role: "user", content: "Prefix", timestamp: 0 }] }), {
		apiKey: token(1),
		sessionId: "example",
		transport: "websocket-cached",
		env: {},
		fetch: async () => {
			throw new Error("No HTTP fallback expected");
		},
		...options,
	}).result();
}

afterEach(async () => {
	await closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	Socket.reset();
});

describe("Codex connection identity", () => {
	it("reuses a matching connection and exact input prefix", async () => {
		vi.stubGlobal("WebSocket", Socket);
		expect((await request()).stopReason).toBe("stop");
		expect((await request()).stopReason).toBe("stop");
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0]?.requests[1]).toMatchObject({ previous_response_id: "response-1", input: [] });
	});

	it.each(["token", "endpoint", "header", "proxy"])("does not reuse a socket after its %s changes", async (change) => {
		vi.stubGlobal("WebSocket", Socket);
		expect((await request()).stopReason).toBe("stop");
		const options: StreamOptions =
			change === "token"
				? { apiKey: token(2) }
				: change === "header"
					? { headers: { "x-route": "new" } }
					: change === "proxy"
						? { env: { HTTPS_PROXY: "http://proxy.invalid:8080", NO_PROXY: "" } }
						: {};
		const selected = change === "endpoint" ? { ...model, baseUrl: "https://other.invalid/v1" } : model;
		expect((await request(options, selected)).stopReason).toBe("stop");
		expect(Socket.instances).toHaveLength(2);
		expect(Socket.instances[0]?.readyState).toBe(3);
		expect(Socket.instances[1]?.requests[0]?.previous_response_id).toBeUndefined();
		expect(Socket.instances[1]?.requests[0]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Prefix" }] },
		]);
	});

	it("retains the socket but sends full context when non-input settings change", async () => {
		vi.stubGlobal("WebSocket", Socket);
		expect((await request()).stopReason).toBe("stop");
		expect((await request({ temperature: 0.5 })).stopReason).toBe("stop");
		expect(Socket.instances).toHaveLength(1);
		expect(Socket.instances[0]?.requests[1]?.previous_response_id).toBeUndefined();
	});
});
