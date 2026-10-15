import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Admissions, type AdmittedMessage } from "../src/core/admission.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
const owners: Admissions[] = [];
const message: AdmittedMessage = { customType: "fixture", content: "result", display: true, details: { value: 1 } };
function fixture(manager?: SessionManager) {
	if (!manager) {
		const directory = mkdtempSync(join(tmpdir(), "pi-admission-"));
		directories.push(directory);
		manager = SessionManager.open(join(directory, "session.jsonl"), directory, directory);
	}
	const queue: CustomMessage[] = [];
	const executing = new Set<string>();
	let idle = false;
	const start = vi.fn(async () => {});
	const owner = new Admissions(manager, {
		queue: (input) => {
			queue.push(input);
		},
		queued: (id) => queue.some((input) => input.inputId === id),
		executing: (id) => executing.has(id),
		discard: (id) => {
			const index = queue.findIndex((input) => input.inputId === id);
			if (index >= 0) queue.splice(index, 1);
		},
		start,
		idle: () => idle,
		warn: (error) => {
			throw error;
		},
	});
	owners.push(owner);
	owner.start();
	return {
		owner,
		manager,
		queue,
		executing,
		start,
		idle: () => {
			idle = true;
		},
		project() {
			const input = queue.shift()!;
			expect(owner.allowed(input.inputId!)).toBe(true);
			const id = manager!.appendCustomMessageEntry(
				input.customType,
				input.content,
				input.display,
				input.details,
				input.inputId,
			);
			owner.accept(manager!.getEntry(id)!);
			return id;
		},
	};
}
afterEach(() => {
	for (const owner of owners.splice(0)) owner.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
});

describe("durable custom input admission", () => {
	it("returns synced custody before any delivery and recovers after reopening", () => {
		const f = fixture();
		const request = f.owner.admit("receipt", message);
		const reopened = SessionManager.open(f.manager.getSessionFile()!);
		expect(reopened.getEntry(request)).toMatchObject({
			type: "custom",
			customType: "pi-input",
			data: { id: "receipt", action: "admit" },
		});
		f.owner.close();
		const recovered = fixture(reopened);
		expect(recovered.queue).toHaveLength(1);
		expect(recovered.owner.admit("receipt", message)).toBe(request);
		expect(recovered.queue).toHaveLength(1);
		recovered.project();
		expect(recovered.owner.allowed(request)).toBe(false);
	});

	it("deduplicates abort, navigation, and re-offer without restarting inference", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const anchor = f.manager.appendCustomEntry("anchor", {});
		f.idle();
		const request = f.owner.admit("receipt", message);
		f.owner.suspend();
		f.manager.branch(anchor);
		expect(f.owner.admit("receipt", message)).toBe(request);
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.start).not.toHaveBeenCalled();
		expect(f.queue).toHaveLength(1);
		f.owner.resume();
		f.project();
		expect(f.manager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("records an explicit replay request only after prior delivery is absent from the selected branch", () => {
		const f = fixture();
		const anchor = f.manager.appendCustomEntry("anchor", {});
		const first = f.owner.admit("receipt", message);
		const delivered = f.project();
		expect(f.owner.admit("receipt", message)).toBe(first);
		expect(f.queue).toHaveLength(0);
		f.manager.branch(anchor);
		const replay = f.owner.admit("receipt", message);
		expect(replay).not.toBe(first);
		expect(f.owner.admit("receipt", message)).toBe(replay);
		f.project();
		f.manager.branch(delivered);
		expect(f.owner.admit("receipt", message)).toBe(first);
		expect(f.queue).toHaveLength(0);
	});

	it("does not requeue pulled but unprojected input when another receipt arrives", () => {
		const f = fixture();
		const first = f.owner.admit("first", message);
		f.queue.shift(); // Agent owns the input while message hooks are running.
		f.owner.admit("second", { ...message, content: "second" });
		expect(f.queue).toHaveLength(1);
		expect(f.queue[0].inputId).not.toBe(first);
		expect(f.owner.admit("first", message)).toBe(first);
		expect(f.queue).toHaveLength(1);
		f.owner.settle(false); // Projection failed; the owner reclaims the unfulfilled request.
		expect(f.queue.map((input) => input.inputId)).toContain(first);
	});

	it("cancellation persists across navigation and restart", () => {
		const f = fixture();
		const anchor = f.manager.appendCustomEntry("anchor", {});
		const request = f.owner.admit("receipt", message);
		f.owner.cancel("receipt");
		expect(f.queue).toHaveLength(0);
		expect(f.owner.allowed(request)).toBe(false);
		f.manager.branch(anchor);
		expect(() => f.owner.admit("receipt", message)).toThrow("cancelled");
		const recovered = fixture(SessionManager.open(f.manager.getSessionFile()!));
		expect(recovered.queue).toHaveLength(0);
		expect(() => recovered.owner.admit("receipt", message)).toThrow("cancelled");
	});

	it("rejects changed content and nonpersisted sessions", () => {
		const f = fixture();
		f.owner.admit("receipt", message);
		expect(() => f.owner.admit("receipt", { ...message, content: "different" })).toThrow("changed content");
		const memory = fixture(SessionManager.inMemory());
		expect(() => memory.owner.admit("receipt", message)).toThrow("persisted session");
	});

	it("fulfills tool-result admissions without a second custom message", () => {
		const f = fixture();
		const request = f.owner.admit("receipt", message, { toolCallId: "tool" });
		expect(f.queue).toHaveLength(0);
		const id = f.manager.appendMessage(
			{
				role: "toolResult",
				toolCallId: "tool",
				toolName: "fixture",
				content: [],
				details: { inputIds: [request] },
				isError: false,
				timestamp: 0,
			},
			{ durable: true },
		);
		f.owner.accept(f.manager.getEntry(id)!);
		f.owner.settle(false);
		expect(f.queue).toHaveLength(0);
		const recovered = fixture(SessionManager.open(f.manager.getSessionFile()!));
		expect(recovered.queue).toHaveLength(0);
	});

	it.each([undefined, { inputIds: ["wrong-request"] }])(
		"does not fulfill unmarked or unrelated tool results: %j",
		(details) => {
			const f = fixture();
			const request = f.owner.admit("receipt", message, { toolCallId: "tool" });
			const result = {
				role: "toolResult" as const,
				toolCallId: "tool",
				toolName: "fixture",
				content: [],
				details,
				isError: false,
				timestamp: 0,
			};
			expect(f.owner.toolResult(result)).toBe(false);
			const entry = f.manager.appendMessage(result);
			f.owner.accept(f.manager.getEntry(entry)!);
			f.owner.settle(false);
			expect(f.queue.map((input) => input.inputId)).toEqual([request]);
			const recovered = fixture(SessionManager.open(f.manager.getSessionFile()!));
			expect(recovered.queue.map((input) => input.inputId)).toEqual([request]);
		},
	);

	it("reclaims only finished tool admissions at a completed turn boundary", () => {
		const f = fixture();
		f.executing.add("tool");
		const request = f.owner.admit("receipt", message, { toolCallId: "tool" });
		f.owner.boundary();
		expect(f.queue).toHaveLength(0);
		f.executing.delete("tool");
		f.owner.boundary();
		expect(f.queue.map((input) => input.inputId)).toEqual([request]);
		f.owner.boundary();
		expect(f.queue).toHaveLength(1);
	});

	it("retains an unfinished tool-result admission for restart recovery", () => {
		const f = fixture();
		f.owner.admit("receipt", message, { toolCallId: "missing" });
		const recovered = fixture(SessionManager.open(f.manager.getSessionFile()!));
		expect(recovered.queue).toHaveLength(1);
		recovered.project();
		expect(recovered.queue).toHaveLength(0);
	});
});
