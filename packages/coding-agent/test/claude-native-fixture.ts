import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export interface NativeRequest {
	model: string;
	system?: unknown;
	tools?: { name: string }[];
	messages: { role: string; content: string | { type: string; text?: string; tool_use_id?: string }[] }[];
}
export type NativeBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Real native protocol, deterministic loopback responses, no provider credentials. */
export async function nativeEndpoint(
	respond: (
		body: NativeRequest,
		index: number,
	) => NativeBlock[] | { before?: NativeBlock[]; partial: NativeBlock } | { status: number; error: string },
) {
	const requests: NativeRequest[] = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		if (request.url?.includes("count_tokens")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ input_tokens: 50 }));
			return;
		}
		if (!request.url?.includes("/v1/messages")) {
			response.writeHead(404);
			response.end();
			return;
		}
		const body: NativeRequest = JSON.parse(raw);
		requests.push(body);
		const reply = respond(body, requests.length);
		if ("status" in reply) {
			response.writeHead(reply.status, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.error } }),
			);
			return;
		}
		const partial = !Array.isArray(reply);
		const content = Array.isArray(reply) ? reply : [...(reply.before ?? []), reply.partial];
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const emit = (type: string, value: Record<string, unknown>) =>
			response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
		emit("message_start", {
			message: {
				id: randomUUID(),
				type: "message",
				role: "assistant",
				model: body.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 50, output_tokens: 1 },
			},
		});
		for (const [index, block] of content.entries()) {
			const unfinished = partial && index === content.length - 1;
			emit("content_block_start", {
				index,
				content_block:
					block.type === "text"
						? { ...block, text: "" }
						: block.type === "thinking"
							? { ...block, thinking: "", signature: "" }
							: block.type === "tool_use"
								? { ...block, input: {} }
								: block,
			});
			if (block.type === "text")
				emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
			if (block.type === "thinking") {
				emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
				if (!unfinished)
					emit("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
			}
			if (block.type === "tool_use")
				emit("content_block_delta", {
					index,
					delta: {
						type: "input_json_delta",
						partial_json: unfinished ? JSON.stringify(block.input).slice(0, -1) : JSON.stringify(block.input),
					},
				});
			// Keep generating an unfinished tool argument, rather than simulate a stalled HTTP connection.
			if (unfinished) {
				if (block.type === "tool_use") {
					const tokens = setInterval(
						() => emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: " " } }),
						10,
					);
					response.once("close", () => clearInterval(tokens));
				}
				return;
			}
			emit("content_block_stop", { index });
		}
		emit("message_delta", {
			delta: {
				stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
				stop_sequence: null,
			},
			usage: { output_tokens: 8 },
		});
		emit("message_stop", {});
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No local endpoint");
	return {
		requests,
		url: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export function toolEndpoint(count = 2) {
	return nativeEndpoint((body, index) => {
		const complete = body.messages.some(
			(message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"),
		);
		return complete
			? [{ type: "text", text: `Native final ${index}.` }]
			: [
					{ type: "thinking", thinking: "Considering tools.", signature: "fixture-signature" },
					{ type: "redacted_thinking", data: "opaque-thinking-payload" },
					{ type: "text", text: "Before native tools." },
					...Array.from(
						{ length: count },
						(_, call): NativeBlock => ({
							type: "tool_use",
							id: `call-${index}-${call}`,
							name: "mcp__pi__probe",
							input: {},
						}),
					),
				];
	});
}

export function nativeEnv(config: string, url: string): Record<string, string> {
	return {
		CLAUDE_CONFIG_DIR: config,
		ANTHROPIC_API_KEY: "local-test-key",
		ANTHROPIC_AUTH_TOKEN: "",
		CLAUDE_CODE_OAUTH_TOKEN: "",
		ANTHROPIC_BASE_URL: url,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		CLAUDE_CODE_USE_BEDROCK: "0",
		CLAUDE_CODE_USE_VERTEX: "0",
		CLAUDE_CODE_USE_FOUNDRY: "0",
		NO_PROXY: "127.0.0.1,localhost",
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		DISABLE_AUTO_COMPACT: "1",
		DISABLE_COMPACT: "1",
	};
}
