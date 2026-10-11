import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

it("executes commands during a live request without prompts, aborts or queues", async () => {
	let api!: ExtensionAPI;
	const calls: string[] = [];
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.registerCommand("mode", {
					handler: async (args, ctx) => {
						expect(ctx.isIdle()).toBe(false);
						calls.push(args);
					},
				});
				pi.registerCommand("fail", {
					handler: async () => {
						throw new Error("handler failure");
					},
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		async () => {
			entered();
			await waiting;
			return fauxAssistantMessage("done");
		},
	]);
	const turn = harness.session.prompt("work");
	try {
		await started;
		await api.executeCommand("/mode off");
		await api.executeCommand("/mode\ton");
		await expect(api.executeCommand("/missing")).rejects.toThrow("Unknown extension command");
		await expect(api.executeCommand("/fail")).rejects.toThrow("handler failure");
		await expect(api.executeCommand("plain text")).rejects.toThrow("Expected a slash command");
		expect(calls).toEqual(["off", "on"]);
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(getUserTexts(harness)).toEqual(["work"]);
	} finally {
		release();
		await turn;
	}
	expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	expect(harness.eventsOfType("agent_settled")[0].aborted).toBe(false);
});

it("awaits handlers, resolves qualified names, and rejects stale extension APIs", async () => {
	let api!: ExtensionAPI;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.registerCommand("same", {
					handler: async () => {
						await waiting;
						calls.push("first");
					},
				});
			},
			(pi) => {
				pi.registerCommand("same", {
					handler: async () => {
						calls.push("second");
					},
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	await expect(api.executeCommand("/same")).rejects.toThrow("Unknown extension command");
	let completed = false;
	const execution = api.executeCommand("/same:1").then(() => {
		completed = true;
	});
	await Promise.resolve();
	expect(completed).toBe(false);
	release();
	await execution;
	await api.executeCommand("/same:2");
	expect(calls).toEqual(["first", "second"]);
	harness.session.extensionRunner!.invalidate();
	await expect(api.executeCommand("/same:2")).rejects.toThrow("stale");
});
