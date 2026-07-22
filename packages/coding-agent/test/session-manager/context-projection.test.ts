import { CACHE_CHECKPOINT } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildContextEntries,
	buildSessionContext,
	type ContextProjection,
	type ContextProjectionFrame,
	type CustomEntry,
	PROJECTION_TYPE,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "../../src/core/session-manager.ts";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") return { ...base, message: { role, content: text, timestamp: 1 } };
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function assistantCall(id: string, parentId: string | null, callId: string): SessionMessageEntry {
	const entry = msg(id, parentId, "assistant", "");
	if (entry.message.role !== "assistant") throw new Error("expected assistant message");
	entry.message.content = [{ type: "toolCall", id: callId, name: "read", arguments: { path: "file" } }];
	entry.message.stopReason = "toolUse";
	return entry;
}

function toolResult(id: string, parentId: string | null, callId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
	};
}

function custom(id: string, parentId: string | null, customType: string, data?: unknown): CustomEntry {
	return { type: "custom", id, parentId, timestamp: "2025-01-01T00:00:00Z", customType, data };
}

function projection(id: string, parentId: string | null, data: ContextProjection): CustomEntry<ContextProjection> {
	return custom(id, parentId, PROJECTION_TYPE, data) as CustomEntry<ContextProjection>;
}

function projectionFrame(
	id: string,
	parentId: string | null,
	data: ContextProjectionFrame,
): CustomEntry<ContextProjectionFrame> {
	return custom(id, parentId, PROJECTION_TYPE, data) as CustomEntry<ContextProjectionFrame>;
}

describe("with projections", () => {
	it("replaces arbitrary source entries at their first position", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "search attempt"),
			msg("2", "1", "assistant", "raw output"),
			msg("3", "2", "user", "retained work"),
			projection("4", "3", {
				key: "test:archive",
				sourceEntryIds: ["1", "2"],
				replacement: {
					customType: "test-archive",
					content: "The search established the final location.",
					display: true,
					details: { sourceCount: 2 },
				},
			}),
			msg("5", "4", "user", "current work"),
		];

		const projected = buildContextEntries(entries);
		expect(projected.map((entry) => entry.id)).toEqual(["4", "3", "5"]);
		expect(projected[0]).toMatchObject({
			type: "custom_message",
			customType: "test-archive",
			content: "The search established the final location.",
			display: true,
		});
		expect(buildSessionContext(entries).messages.map((message) => message.role)).toEqual(["custom", "user", "user"]);
	});

	it("inserts an ordered replacement message sequence", () => {
		const bridgeResult = toolResult("bridge-result", null, "prior-call", "Result archived in summary.").message;
		const bridgeCall = assistantCall("bridge-call", null, "later-call").message;
		const entries: SessionEntry[] = [
			msg("1", null, "user", "before"),
			msg("2", "1", "assistant", "replace me"),
			projection("3", "2", {
				key: "test:sequence",
				sourceEntryIds: ["2"],
				replacement: {
					messages: [
						bridgeResult,
						{
							role: "custom",
							customType: "test-archive",
							content: "summary",
							display: true,
							timestamp: 2,
						},
						bridgeCall,
					],
				},
			}),
			msg("4", "3", "user", "after"),
		];

		const projected = buildContextEntries(entries);
		expect(projected.map((entry) => entry.id)).toEqual(["1", "3", "3:1", "3:2", "4"]);
		expect(projected.slice(1, 4).map((entry) => entry.type)).toEqual(["message", "custom_message", "message"]);
		expect(buildSessionContext(entries).messages.map((message) => message.role)).toEqual([
			"user",
			"toolResult",
			"custom",
			"assistant",
			"user",
		]);
	});

	it("applies many disjoint directives from one frame", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first raw"),
			msg("2", "1", "assistant", "second raw"),
			msg("3", "2", "user", "middle raw"),
			msg("4", "3", "assistant", "fourth raw"),
			projectionFrame("5", "4", {
				version: 2,
				key: "test:frame",
				generation: 1,
				fingerprint: "frame-1",
				directives: [
					{
						key: "first-pair",
						sourceEntryIds: ["1", "2"],
						replacement: { customType: "summary", content: "first summary", display: true },
					},
					{
						key: "last",
						sourceEntryIds: ["4"],
						replacement: { customType: "summary", content: "last summary", display: true },
					},
				],
			}),
			msg("6", "5", "user", "current"),
		];

		const projected = buildContextEntries(entries);
		expect(projected.map((entry) => entry.id)).toEqual(["5", "3", "5:d1", "6"]);
		expect(
			projected
				.flatMap(sessionEntryToContextMessages)
				.map((message) => ("content" in message ? message.content : undefined)),
		).toEqual(["first summary", "middle raw", "last summary", "current"]);
	});

	it("places a replacement at its explicit historical anchor", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first raw"),
			msg("2", "1", "assistant", "middle raw"),
			msg("3", "2", "user", "last raw"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:placement",
				generation: 1,
				fingerprint: "placement-1",
				directives: [
					{
						key: "placed",
						sourceEntryIds: ["1", "3"],
						anchorEntryId: "3",
						replacement: { customType: "summary", content: "placed summary", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["2", "4"]);
	});

	it("preserves every replacement sharing one unsuppressed anchor", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first raw"),
			msg("2", "1", "assistant", "shared anchor"),
			msg("3", "2", "user", "last raw"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:shared-anchor",
				generation: 1,
				fingerprint: "shared-anchor-1",
				directives: [
					{
						key: "first",
						sourceEntryIds: ["1"],
						anchorEntryId: "2",
						replacement: { customType: "summary", content: "first summary", display: true },
					},
					{
						key: "last",
						sourceEntryIds: ["3"],
						anchorEntryId: "2",
						replacement: { customType: "summary", content: "last summary", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["4", "4:d1", "2"]);
	});

	it("separates source suppression from independently placed summaries", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first raw"),
			msg("2", "1", "assistant", "middle raw"),
			msg("3", "2", "user", "last raw"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:independent-placement",
				generation: 1,
				fingerprint: "independent-placement-1",
				directives: [
					{
						key: "suppress",
						sourceEntryIds: ["1", "3"],
						replacement: { messages: [] },
					},
					{
						key: "first-summary",
						sourceEntryIds: [],
						anchorEntryId: "1",
						replacement: { customType: "summary", content: "first summary", display: true },
					},
					{
						key: "last-summary",
						sourceEntryIds: [],
						anchorEntryId: "3",
						replacement: { customType: "summary", content: "last summary", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["4:d1", "2", "4:d2"]);
	});

	it("replaces an owned frame as a whole", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first raw"),
			msg("2", "1", "assistant", "second raw"),
			msg("3", "2", "user", "third raw"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:frame",
				generation: 1,
				fingerprint: "frame-1",
				directives: [
					{
						key: "first",
						sourceEntryIds: ["1"],
						replacement: { customType: "summary", content: "old first", display: true },
					},
					{
						key: "third",
						sourceEntryIds: ["3"],
						replacement: { customType: "summary", content: "old third", display: true },
					},
				],
			}),
			projectionFrame("5", "4", {
				version: 2,
				key: "test:frame",
				generation: 2,
				fingerprint: "frame-2",
				directives: [
					{
						key: "third",
						sourceEntryIds: ["3"],
						replacement: { customType: "summary", content: "new third", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["1", "2", "5"]);
		expect(buildContextEntries(entries, "4").map((entry) => entry.id)).toEqual(["4", "2", "4:d1"]);
	});

	it("marks the stable prefix before the union of old and new projection ranges", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "stable prefix"),
			msg("2", "1", "assistant", "old source"),
			msg("3", "2", "user", "new source"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:checkpoint",
				generation: 1,
				fingerprint: "checkpoint-1",
				directives: [
					{
						key: "old",
						sourceEntryIds: ["2"],
						replacement: { customType: "summary", content: "old summary", display: true },
					},
				],
			}),
			msg("5", "4", "assistant", "unchanged tail"),
			projectionFrame("6", "5", {
				version: 2,
				key: "test:checkpoint",
				generation: 2,
				fingerprint: "checkpoint-2",
				directives: [
					{
						key: "new",
						sourceEntryIds: ["3"],
						replacement: { customType: "summary", content: "new summary", display: true },
					},
				],
			}),
			msg("7", "6", "user", "current"),
		];

		const projected = buildContextEntries(entries);
		expect(projected.find((entry) => entry.id === "1")?.[CACHE_CHECKPOINT]).toBe(true);
		expect(projected.filter((entry) => entry[CACHE_CHECKPOINT])).toHaveLength(1);
		const checkpoint = buildSessionContext(entries).messages[0];
		expect(checkpoint).toMatchObject({ role: "user", content: "stable prefix" });
		expect((checkpoint as typeof checkpoint & { [CACHE_CHECKPOINT]?: true })[CACHE_CHECKPOINT]).toBe(true);
		expect(entries[0][CACHE_CHECKPOINT]).toBeUndefined();
	});

	it("marks the stable prefix when a replacement frame clears its prior range", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "stable prefix"),
			msg("2", "1", "assistant", "restored source"),
			projectionFrame("3", "2", {
				version: 2,
				key: "test:clear-checkpoint",
				generation: 1,
				fingerprint: "clear-checkpoint-1",
				directives: [
					{
						key: "old",
						sourceEntryIds: ["2"],
						replacement: { customType: "summary", content: "old summary", display: true },
					},
				],
			}),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:clear-checkpoint",
				generation: 2,
				fingerprint: "clear-checkpoint-2",
				directives: [],
			}),
			msg("5", "4", "user", "current"),
		];

		const projected = buildContextEntries(entries);
		expect(projected.map((entry) => entry.id)).toEqual(["1", "2", "5"]);
		expect(projected[0][CACHE_CHECKPOINT]).toBe(true);
	});

	it("rejects an internally overlapping frame without partially applying it", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "second"),
			projectionFrame("3", "2", {
				version: 2,
				key: "test:invalid",
				generation: 1,
				fingerprint: "invalid",
				directives: [
					{
						key: "left",
						sourceEntryIds: ["1", "2"],
						replacement: { customType: "summary", content: "left", display: true },
					},
					{
						key: "right",
						sourceEntryIds: ["2"],
						replacement: { customType: "summary", content: "right", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["1", "2", "3"]);
		expect(buildSessionContext(entries).messages).toMatchObject([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		]);
	});

	it("rejects an older overlapping frame as one atomic unit", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "second"),
			msg("3", "2", "user", "third"),
			projectionFrame("4", "3", {
				version: 2,
				key: "test:older-frame",
				generation: 1,
				fingerprint: "older",
				directives: [
					{
						key: "first",
						sourceEntryIds: ["1"],
						replacement: { customType: "summary", content: "first summary", display: true },
					},
					{
						key: "third",
						sourceEntryIds: ["3"],
						replacement: { customType: "summary", content: "third summary", display: true },
					},
				],
			}),
			projectionFrame("5", "4", {
				version: 2,
				key: "test:newer-frame",
				generation: 1,
				fingerprint: "newer",
				directives: [
					{
						key: "third",
						sourceEntryIds: ["3"],
						replacement: { customType: "summary", content: "new third", display: true },
					},
				],
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["1", "2", "5"]);
	});

	it("lets a newer overlapping projection own the shared range", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "second"),
			msg("3", "2", "user", "third"),
			projection("4", "3", {
				key: "test:older",
				sourceEntryIds: ["1", "2"],
				replacement: { customType: "older", content: "older summary", display: true },
			}),
			projection("5", "4", {
				key: "test:newer",
				sourceEntryIds: ["2", "3"],
				replacement: { customType: "newer", content: "newer summary", display: true },
			}),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["1", "5"]);
	});

	it("restores sources when a later directive clears the projection", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "second"),
			projection("3", "2", {
				key: "test:archive",
				sourceEntryIds: ["1", "2"],
				replacement: { customType: "test-archive", content: "summary", display: true },
			}),
			projection("4", "3", { key: "test:archive", sourceEntryIds: [], replacement: null }),
		];

		expect(buildContextEntries(entries).map((entry) => entry.id)).toEqual(["1", "2"]);
		expect(buildContextEntries(entries, "2").map((entry) => entry.id)).toEqual(["1", "2"]);
	});
});
