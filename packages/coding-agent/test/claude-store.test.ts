import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeMemory, ClaudeStore } from "../src/core/claude-store.ts";

vi.mock("node:fs", { spy: true });
const record = (uuid: string, parentUuid: string | null = null): SessionStoreEntry => ({
	type: "assistant",
	uuid,
	parentUuid,
	message: { content: [{ type: "text", text: "native 世界" }] },
});

describe("Claude-owned native storage", () => {
	let directory: string;
	let key: SessionKey;
	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-native-store-"));
		key = { projectKey: "../../opaque/project", sessionId: randomUUID() };
	});
	afterEach(() => {
		vi.resetAllMocks();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it("retains opaque records and subkeys across reopening without unsafe filesystem names", async () => {
		const store = new ClaudeStore(directory);
		const child = { ...key, subpath: "subagents/../opaque-child" };
		const opaque = { ...record("a"), vendorField: { nested: [1, false] } };
		const pending = store.append(key, [opaque]);
		opaque.vendorField.nested.push(2);
		await pending;
		await store.append(child, [{ type: "agent_metadata", agentType: "worker" }, record("child")]);
		const reopened = new ClaudeStore(directory);
		expect(await reopened.load(key)).toEqual([{ ...record("a"), vendorField: { nested: [1, false] } }]);
		expect(await reopened.listSubkeys(key)).toEqual([child.subpath]);
		expect(await reopened.load(child)).toEqual([{ type: "agent_metadata", agentType: "worker" }, record("child")]);
		expect(store.path(child)).toMatch(new RegExp(`^${directory}/sessions/[a-f0-9]{64}/[a-f0-9]{64}\\.jsonl$`));
	});

	it.each([true, false])("refuses reopening a source namespace for writes (disk=%s)", async (disk) => {
		const root = disk ? directory : new ClaudeMemory();
		await new ClaudeStore(root).append(key, [record("a")]);
		const reopened = new ClaudeStore(root);
		await reopened.load(key);
		await expect(reopened.append({ ...key, subpath: "new-child" }, [record("b")])).rejects.toThrow(
			"cannot be reopened for writing",
		);
		expect(await new ClaudeStore(root).load(key)).toEqual([record("a")]);
	});

	it("serializes batches, deduplicates retries, and rejects conflicting identities", async () => {
		const store = new ClaudeStore(directory);
		await Promise.all([store.append(key, [record("a")]), store.append(key, [record("b", "a")])]);
		await store.append(key, [record("a"), { type: "marker" }]);
		expect(await store.load(key)).toEqual([record("a"), record("b", "a"), { type: "marker" }]);
		await expect(store.append(key, [{ ...record("a"), altered: true }])).rejects.toThrow("Conflicting native record");
		expect(await new ClaudeStore(directory).load(key)).toEqual([record("a"), record("b", "a"), { type: "marker" }]);
	});

	it("cuts opaque append order, retaining sibling results and excluding future tail damage", async () => {
		const store = new ClaudeStore(directory);
		const entries = [
			record("a"),
			record("b", "a"),
			{ type: "user", uuid: "ra", parentUuid: "a" },
			{ type: "user", uuid: "rb", parentUuid: "b" },
		];
		await store.append(key, entries);
		fs.appendFileSync(store.path(key)!, '{"type":');
		expect(await new ClaudeStore(directory).cut(key, "rb")).toEqual(entries);
		expect(await new ClaudeStore(directory).cut(key, "a")).toEqual([entries[0]]);
		await expect(new ClaudeStore(directory).load(key)).rejects.toThrow("incomplete record");
		await expect(new ClaudeStore(directory).cut(key, "absent")).rejects.toThrow("missing");
	});

	it("stages once in the SDK destination project while its source continues independently", async () => {
		const source = new ClaudeStore(directory);
		await source.append(key, [record("a")]);
		const target = new ClaudeStore(directory);
		const fork = await target.fork(key, "a");
		await source.append(key, [record("b", "a")]);
		const destination = { projectKey: "new-project", sessionId: fork.resume };
		const [entries, subkeys] = await Promise.all([
			fork.sessionStore.load(destination),
			fork.sessionStore.listSubkeys!(destination),
		]);
		expect(entries).toEqual([record("a")]);
		expect(subkeys).toEqual([]);
		await fork.sessionStore.append(destination, [record("branch", "a")]);
		expect(await target.load(destination)).toEqual([record("a"), record("branch", "a")]);
		expect(await source.load(key)).toEqual([record("a"), record("b", "a")]);
		await expect(fork.sessionStore.load({ ...destination, projectKey: "changed" })).rejects.toThrow(
			"project changed",
		);
		await expect(fork.sessionStore.load(key)).rejects.toThrow("unexpected resource");
	});

	it("refuses missing boundaries and child flattening before native staging", async () => {
		const source = new ClaudeStore(directory);
		await source.append(key, [record("a")]);
		await expect(new ClaudeStore(directory).fork(key, "absent")).rejects.toThrow("missing");
		await source.append({ ...key, subpath: "subagents/child" }, [record("child")]);
		await expect(new ClaudeStore(directory).fork(key, "a")).rejects.toThrow("Native child cuts are not implemented");
		await expect(source.fork(key, "a")).rejects.toThrow("fresh writer");
	});

	it("does not publish a native cursor or checkpoint after failed fsync", async () => {
		const store = new ClaudeStore(directory);
		await store.append(key, [record("a")]);
		const pending = expect(store.wait(key.sessionId, "b")).rejects.toThrow("sync failed");
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw new Error("sync failed");
		});
		await expect(store.append(key, [record("b", "a")])).rejects.toThrow("sync failed");
		await pending;
		expect(() => store.bind("checkpoint", { cursor: "b" })).toThrow("sync failed");
	});

	it("fences failed checkpoint publication, including failure after its link becomes visible", () => {
		const store = new ClaudeStore(directory);
		store.bind("existing", { cursor: "a" });
		if (process.platform !== "win32") vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {});
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw new Error("checkpoint sync failed");
		});
		expect(() => store.bind("new", { cursor: "b" })).toThrow("checkpoint sync failed");
		expect(() => store.bind("new", { cursor: "b" })).toThrow("checkpoint sync failed");
	});

	it("publishes immutable checkpoint bindings and rejects conflicting replacement", () => {
		const store = new ClaudeStore(directory);
		store.bind("native-response/canonical-prefix", { cursor: "a" });
		store.bind("native-response/canonical-prefix", { cursor: "a" });
		expect(new ClaudeStore(directory).binding("native-response/canonical-prefix")).toEqual({ cursor: "a" });
		expect(() => store.bind("native-response/canonical-prefix", { cursor: "b" })).toThrow(
			"Conflicting native checkpoint",
		);
	});

	it("releases one memory owner without retaining transcripts or affecting another", async () => {
		const memory = new ClaudeMemory();
		const source = new ClaudeStore(memory);
		const other = new ClaudeStore();
		await source.append(key, [record("a")]);
		await other.append(key, [record("independent")]);
		source.bind("checkpoint", { cursor: "a" });
		const waiter = expect(source.wait(key.sessionId, "pending")).rejects.toThrow();
		memory.close();
		await waiter;
		expect(memory.logs.size).toBe(0);
		expect(memory.bindings.size).toBe(0);
		await expect(source.append(key, [record("late")])).rejects.toThrow("memory session is closed");
		await expect(source.load(key)).rejects.toThrow("memory session is closed");
		expect(() => source.bind("late", {})).toThrow("memory session is closed");
		expect(await other.load(key)).toEqual([record("independent")]);
	});

	it("keeps source namespaces read-only and supports memory-only resources", async () => {
		const memory = new ClaudeMemory();
		const store = new ClaudeStore(memory);
		await store.append(key, [record("a")]);
		expect(await store.wait(key.sessionId, "a")).toEqual(key);
		expect(await new ClaudeStore(memory).cut(key, "a")).toEqual([record("a")]);
		await expect(store.append({ ...key, sessionId: randomUUID() }, [record("other")])).rejects.toThrow(
			"cannot cross session namespaces",
		);
	});
});
