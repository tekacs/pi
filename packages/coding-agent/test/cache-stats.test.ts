import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
	type ModelPriceSource,
} from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const models: ModelPriceSource = {
	// $/million tokens; used as cache-read price fallback on full-miss turns
	getModel: () => ({ cost: { cacheRead: 0.3 } }),
};

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	model?: string;
	timestamp?: number;
	contextTokens?: number;
	entryPrompt?: { input: number; cacheRead: number; cacheWrite: number };
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: options.model ?? "test-model",
		usage: {
			input: options.input ?? 0,
			output: 10,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens: 0,
			contextTokens: options.contextTokens,
			entryPrompt: options.entryPrompt,
			cost: { ...zeroCost, ...options.cost },
		},
		stopReason: "stop",
		timestamp: options.timestamp ?? 0,
	} as AssistantMessage;
}

function entry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: "x", parentId: null, timestamp: "", message } as SessionEntry;
}

// Turn 1: fresh 100k cache write at $3.75/M
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
// Turn 2: healthy, everything read back at $0.30/M
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates missed tokens and cost across turns", () => {
		// Turn 3: full miss, previous 105k prompt re-billed at $3.75/M write
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(turn3)], models);
		expect(totals.missedTokens).toBe(105_000);
		// 105k at ($3.75 - $0.30)/M
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste([entry(turn1), entry(turn2)], models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it("skips the turn after a compaction reset", () => {
		const reset = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;
		const afterReset = assistant({ cacheWrite: 20_000, cost: { cacheWrite: 0.075 } });
		const totals = computeCacheWaste([entry(turn1), reset, entry(afterReset)], models);
		expect(totals.missedTokens).toBe(0);
	});

	it("counts misses caused by model switches", () => {
		const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" });
		const totals = computeCacheWaste([entry(turn1), entry(otherModel)], models);
		expect(totals.missedTokens).toBe(100_000);
		expect(totals.missCount).toBe(1);
	});

	it("skips providers that report no cache activity", () => {
		const a = assistant({ input: 100_000 });
		const b = assistant({ input: 110_000 });
		const totals = computeCacheWaste([entry(a), entry(b)], models);
		expect(totals.missedTokens).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps counted misses to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses([entry(turn1), entry(turn2), entry(missTurn)], models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("detects a miss on a just-completed message with idle time", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missMessage, models);
		expect(miss).toBeDefined();
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		// 600s - 60s since the previous request
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
	});

	it("flags model switches on detected misses", () => {
		const otherModel = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
	});

	it("returns undefined for healthy turns", () => {
		const healthy = assistant({
			cacheRead: 105_000,
			cacheWrite: 2_000,
			cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], healthy, models)).toBeUndefined();
	});

	it("returns undefined for the first turn of a session", () => {
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});
});

// Providers that run an internal agent loop report one Usage per turn, summed over
// every request in it. Requests 2..N re-read the prefix the entry request warmed,
// so the summed buckets describe neither the context left behind nor the cache the
// next turn met. Such providers report contextTokens and entryPrompt separately.
describe("providers that aggregate an internal request loop", () => {
	// One short turn: a single request over a 200k context.
	const shortTurn = assistant({
		cacheRead: 200_000,
		cacheWrite: 2_000,
		cost: { cacheRead: 0.06, cacheWrite: 0.0075 },
		contextTokens: 210_000,
		entryPrompt: { input: 0, cacheRead: 200_000, cacheWrite: 2_000 },
		timestamp: 0,
	});

	it("detects a cold entry request masked by the rest of the loop", () => {
		// Eight requests: the first repriced the whole 210k context, the other seven
		// then read it back, summing to a cacheRead far above the real prompt.
		const coldTurn = assistant({
			cacheRead: 1_470_000,
			cacheWrite: 220_000,
			cost: { cacheRead: 0.441, cacheWrite: 0.825 },
			contextTokens: 240_000,
			entryPrompt: { input: 0, cacheRead: 0, cacheWrite: 210_000 },
			timestamp: 600_000,
		});
		const miss = detectCacheMiss([entry(shortTurn)], coldTurn, models);
		expect(miss?.missedTokens).toBe(210_000);
		expect(miss?.idleMs).toBe(600_000);
	});

	it("counts nothing when the entry request hit and only the loop inflated the buckets", () => {
		const warmTurn = assistant({
			cacheRead: 1_500_000,
			cacheWrite: 20_000,
			cost: { cacheRead: 0.45, cacheWrite: 0.075 },
			contextTokens: 240_000,
			entryPrompt: { input: 0, cacheRead: 210_000, cacheWrite: 3_000 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(shortTurn)], warmTurn, models)).toBeUndefined();
	});

	it("expects the next turn to read back the context left behind, not the summed prompt", () => {
		// A long warm loop leaves 240k in context; a following cold turn must be
		// measured against that, not against the loop's 1.5M of prompt volume.
		const longTurn = assistant({
			cacheRead: 1_500_000,
			cacheWrite: 20_000,
			cost: { cacheRead: 0.45, cacheWrite: 0.075 },
			contextTokens: 240_000,
			entryPrompt: { input: 0, cacheRead: 210_000, cacheWrite: 3_000 },
			timestamp: 0,
		});
		const coldTurn = assistant({
			cacheWrite: 245_000,
			cost: { cacheWrite: 0.919 },
			contextTokens: 250_000,
			entryPrompt: { input: 0, cacheRead: 0, cacheWrite: 245_000 },
			timestamp: 600_000,
		});
		expect(detectCacheMiss([entry(longTurn)], coldTurn, models)?.missedTokens).toBe(240_000);
	});
});
