import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSdkMcpServer,
	query,
	type SDKMessage,
	type SDKUserMessage,
	type SessionKey,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { findBundledClaude } from "../src/core/claude-agent-sdk-stream.ts";
import { ClaudeStore } from "../src/core/claude-store.ts";
import { nativeEnv, toolEndpoint } from "./claude-native-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

/** Protocol probe: deliberately below Pi's adapter, so native ancestry is tested independently. */
async function run(
	root: string,
	cwd: string,
	url: string,
	prompt: string,
	effect: (id: string) => void,
	cut?: { key: SessionKey; cursor: string },
) {
	const store = new ClaudeStore(root);
	const continuation = cut ? await store.fork(cut.key, cut.cursor) : { sessionStore: store };
	let closeInput!: () => void;
	const closed = new Promise<void>((resolve) => {
		closeInput = resolve;
	});
	async function* input(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user",
			message: { role: "user", content: prompt },
			parent_tool_use_id: null,
			client_composed: true,
		};
		await closed;
	}
	const executable = findBundledClaude(process.env.PI_TEST_PACKAGE_DIR);
	expect(executable, "installed native fixture executable").toBeDefined();
	const native = query({
		prompt: input(),
		options: {
			cwd,
			model: "claude-sonnet-4-5",
			pathToClaudeCodeExecutable: executable,
			settingSources: [],
			tools: [],
			allowedTools: ["mcp__pi__*"],
			permissionMode: "dontAsk",
			strictMcpConfig: true,
			includePartialMessages: true,
			thinking: { type: "adaptive" },
			systemPrompt: { type: "custom", prompt: "Local native continuation fixture.", snapshot: false },
			env: nativeEnv(mkdtempSync(join(cwd, "config-")), url),
			...continuation,
			sessionStoreFlush: "eager",
			mcpServers: {
				pi: createSdkMcpServer({
					name: "pi",
					tools: [
						{
							name: "probe",
							description: "Local side effect",
							inputSchema: {},
							handler: async (_args, extra) => {
								const metadata = extra as { _meta?: { "claudecode/toolUseId"?: string } };
								const id = metadata._meta?.["claudecode/toolUseId"];
								if (!id) throw new Error("Missing native call identity");
								effect(id);
								return { content: [{ type: "text", text: `Completed ${id}.` }] };
							},
						},
					],
				}),
			},
		},
	});
	const messages: SDKMessage[] = [];
	try {
		for await (const message of native) {
			messages.push(message);
			if (message.type === "system" && message.subtype === "mirror_error") throw new Error("Native mirror failed");
			if (message.type !== "result") continue;
			expect(message.subtype, JSON.stringify(message)).toBe("success");
			const last = [...messages].reverse().find((entry) => entry.type === "assistant");
			if (!last || last.type !== "assistant") throw new Error("Native assistant boundary absent");
			const key = await store.wait(message.session_id, last.uuid);
			return { messages, key, cursor: last.uuid, store };
		}
		throw new Error("Native result absent");
	} finally {
		closeInput();
		native.close();
	}
}

describe("opaque native prefix protocol", () => {
	it("preserves parallel results and thinking cuts across independent fresh namespaces", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-native-prefix-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const endpoint = await toolEndpoint();
		cleanups.push(endpoint.close);
		const root = join(directory, "native");
		const effects: string[] = [];
		const effect = (id: string) => {
			effects.push(id);
		};
		const source = await run(root, directory, endpoint.url, "Run two tools", effect);
		expect(effects.sort()).toEqual(["call-1-0", "call-1-1"]);
		const results = source.messages.filter(
			(message) =>
				message.type === "user" &&
				Array.isArray(message.message.content) &&
				message.message.content.some((block) => block.type === "tool_result"),
		);
		const result = results.at(-1);
		if (!result || result.type !== "user" || !result.uuid) throw new Error("No native result cursor");
		const before = source.messages.find(
			(message) =>
				message.type === "assistant" &&
				message.message.content.some((block) => block.type === "text" && block.text === "Before native tools."),
		);
		if (!before || before.type !== "assistant") throw new Error("No native intermediate cursor");
		const other = join(directory, "other-project");
		mkdirSync(other);
		const branch = await run(root, other, endpoint.url, "Continue fork", effect, {
			key: source.key,
			cursor: result.uuid,
		});
		const original = await run(root, directory, endpoint.url, "Continue original", effect, source);
		expect(branch.key.sessionId).not.toBe(source.key.sessionId);
		expect(original.key.sessionId).not.toBe(source.key.sessionId);
		expect(branch.key.sessionId).not.toBe(original.key.sessionId);
		expect(effects).toHaveLength(2);
		expect(endpoint.requests).toHaveLength(4);
		const forkInput = endpoint.requests[2];
		const resultIds = forkInput.messages
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((block) => block.type === "tool_result")
			.map((block) => block.tool_use_id)
			.sort();
		expect(resultIds).toEqual(["call-1-0", "call-1-1"]);
		// Matching IDs alone would also accept native-generated missing-result errors.
		expect(JSON.stringify(forkInput.messages)).toContain("Completed call-1-0.");
		expect(JSON.stringify(forkInput.messages)).toContain("Completed call-1-1.");
		expect(JSON.stringify(forkInput.messages)).not.toContain("Native final 2.");
		expect(JSON.stringify(endpoint.requests[3].messages)).toContain("Native final 2.");
		expect(JSON.stringify(endpoint.requests[3].messages)).not.toContain("Continue fork");
		await run(root, directory, endpoint.url, "Continue before tools", effect, {
			key: source.key,
			cursor: before.uuid,
		});
		expect(effects).toHaveLength(4);
		expect(endpoint.requests).toHaveLength(6);
		const early = JSON.stringify(endpoint.requests[4].messages);
		expect(early).toContain("fixture-signature");
		expect(early).toContain("opaque-thinking-payload");
		expect(early).toContain("Before native tools.");
		expect(early).not.toContain("Completed call-1");
		expect(early).not.toContain("Continue fork");
		expect(early).not.toContain("Continue original");
	}, 60_000);
});
