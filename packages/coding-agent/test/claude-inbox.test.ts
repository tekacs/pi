import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { nativeEndpoint } from "./claude-native-fixture.ts";
import { nativeSession, settled } from "./claude-session-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

it.each([false, true])(
	"wakes from an inbox with stale native leaf metadata (imported suffix=%s)",
	async (suffix) => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-inbox-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await nativeEndpoint((_body, index) => [
			{ type: "thinking", thinking: "Preserved native thought.", signature: "preserved-signature" },
			{ type: "text", text: `Native answer ${index}.` },
		]);
		cleanups.push(endpoint.close);
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Unused",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("Unexpected tool execution");
			},
		};
		const manager = SessionManager.create(root, join(root, "sessions"));
		const initial = await nativeSession(manager, root, endpoint.url, tool);
		cleanups.push(initial.close);
		await initial.session.prompt("Initial request.");
		settled(initial.session);
		initial.close();
		const directory = join(root, "native", "sessions");
		const file = readdirSync(directory, { recursive: true }).find((name) => String(name).endsWith("main.jsonl"))!;
		const path = join(directory, String(file));
		const records: SessionStoreEntry[] = readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const stale = records.find((record) => record.type === "user")!;
		const last = records.length - 1 - [...records].reverse().findIndex((record) => record.type === "assistant");
		records.splice(last, 0, {
			type: "last-prompt",
			leafUuid: stale.uuid,
			sessionId: stale.sessionId,
			explicit: true,
		});
		const source = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		writeFileSync(path, source);
		if (suffix) {
			const reply = manager.buildSessionContext().messages.find((message) => message.role === "assistant")!;
			if (reply.role !== "assistant") throw new Error("No native reply");
			manager.appendMessage({
				...reply,
				api: "openai-responses",
				provider: "openai",
				responseId: "foreign",
				content: [{ type: "text", text: "Intervening foreign reply." }],
			});
		}
		const resumed = await nativeSession(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
		cleanups.push(resumed.close);
		await resumed.session.sendCustomMessage(
			{ customType: "agent-fixes", content: "AF Inbox: Please compare notes.", display: true },
			{ triggerTurn: true },
		);
		settled(resumed.session);
		expect(endpoint.requests).toHaveLength(2);
		const input = JSON.stringify(endpoint.requests[1].messages);
		expect(input).toContain("AF Inbox: Please compare notes.");
		expect(input).toContain("Native answer 1.");
		expect(input).toContain("preserved-signature");
		if (suffix) expect(input).toContain("Intervening foreign reply.");
		// The source producer may append shutdown metadata; its existing prefix must not change.
		expect(readFileSync(path, "utf8").startsWith(source)).toBe(true);
		await resumed.session.prompt("Manual follow-up.");
		settled(resumed.session);
		expect(endpoint.requests).toHaveLength(3);
	},
	60_000,
);
