import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingMode;
		branch?: SessionEntry[];
		maxIdleAgeMs?: number;
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = {
		mode: options.mode ?? "idle",
		branch: options.branch ?? branchWithPrompt(100_000),
		maxIdleAgeMs: options.maxIdleAgeMs,
	};
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
		state.maxIdleAgeMs === undefined ? undefined : () => state.maxIdleAgeMs!,
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

beforeEach(() => vi.stubEnv("PI_CACHE_RETENTION", "short"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("cache warming", () => {
	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		expect([
			getCacheWarmingDelayMs(300_000),
			getCacheWarmingDelayMs(110_000),
			getCacheWarmingDelayMs(60_000),
			getCacheWarmingDelayMs(10_000),
		]).toEqual([270_000, 85_000, 50_000, undefined]);
		expect([
			isCacheWarmingReplayable(budgetModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(budgetModel, undefined),
			isCacheWarmingReplayable(adaptiveModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(openaiModel, { reasoning: "medium" }),
		]).toEqual([false, true, true, true]);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: {
				reasoning: "high",
				sessionId: "s",
				transformHeaders,
				maxTokens: 1,
				maxRetries: 0,
				disableContinuation: true,
			},
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current);
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current);
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		unsupported.warmer.start(request(unknownModel), current);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		unsupported.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current);
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and does not record failed refreshes", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		pending.warmer.start(request(), current);
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);

		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		failed.warmer.cancel();
	});

	it("keeps warming when a single miss re-populates the cache and stops after two consecutive misses", async () => {
		vi.useFakeTimers();
		// A single miss just paid to re-populate the cache; a hit on the next refresh resets the miss streak.
		let recoveryAttempt = 0;
		const recovered = fakeRuntime({
			result: async (model) => {
				recoveryAttempt++;
				const isMiss = recoveryAttempt === 1 || recoveryAttempt === 3;
				return {
					...response(model),
					usage: isMiss
						? { ...warmUsage, input: 100_000, cacheRead: 0, totalTokens: 100_001 }
						: { ...warmUsage, input: 0, cacheRead: 100_000, totalTokens: 100_001 },
				};
			},
		});
		recovered.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(recovered.calls).toHaveLength(1);
		expect(recovered.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(recovered.calls).toHaveLength(2);
		expect(recovered.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(recovered.calls).toHaveLength(3);
		expect(recovered.warmer.status.state).toBe("scheduled");
		recovered.warmer.cancel();

		// Two consecutive cold misses prove the cache is not sticking and stop warming.
		const coldMiss = fakeRuntime({
			result: async (model) => ({
				...response(model),
				usage: { ...warmUsage, input: 100_000, cacheRead: 0, totalTokens: 100_001 },
			}),
		});
		coldMiss.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(coldMiss.calls).toHaveLength(1);
		expect(coldMiss.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(coldMiss.calls).toHaveLength(2);
		expect(coldMiss.appendUsage).toHaveBeenCalledTimes(2);
		expect(coldMiss.warmer.status).toMatchObject({ state: "inactive", reason: "prompt cache entry was evicted" });
		await vi.advanceTimersByTimeAsync(270_000);
		expect(coldMiss.calls).toHaveLength(2);

		const largeEvicted = fakeRuntime({
			branch: branchWithPrompt(500_000),
			result: async (model) => ({
				...response(model),
				usage: { ...warmUsage, input: 458_000, cacheRead: 42_000, totalTokens: 500_001 },
			}),
		});
		largeEvicted.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(largeEvicted.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(largeEvicted.calls).toHaveLength(2);
		expect(largeEvicted.warmer.status).toMatchObject({ state: "inactive", reason: "prompt cache entry was evicted" });

		// Partial hits on <200k prompts or >=20% hits on large prompts keep warming without false positives.
		const partialHit = fakeRuntime({
			branch: branchWithPrompt(90_000),
			result: async (model) => ({
				...response(model),
				usage: { ...warmUsage, input: 54_000, cacheRead: 36_000, totalTokens: 90_001 },
			}),
		});
		partialHit.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(partialHit.calls).toHaveLength(1);
		expect(partialHit.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(partialHit.calls).toHaveLength(2);
		partialHit.warmer.cancel();
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry.usage.cost.total, entry.note)).toBe(
			"Cache warmed (extension override): $0.029497",
		);
	});

	it("stops idle warming at the default 15-minute cutoff while keeping active streaming sessions warm and resuming on the next turn", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		// Active streaming session keeps warming past 15 minutes (4 refreshes at 4.5m, 9m, 13.5m, 18m).
		const active = fakeRuntime({ branch: branchWithPrompt(400_000) });
		active.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(active.calls).toHaveLength(4);
		expect(active.warmer.status.state).toBe("scheduled");
		active.warmer.cancel();

		// Idle parked session warms only within the 15-minute idle cutoff (at 4.5m, 9m, 13.5m),
		// then stops once the next warm (18m) would exceed 15m.
		const parked = fakeRuntime({ branch: branchWithPrompt(400_000) });
		parked.warmer.start(request(), current);
		parked.warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(parked.calls).toHaveLength(3);
		expect(parked.warmer.status).toEqual({
			state: "inactive",
			reason: "15-minute idle safety limit reached",
		});

		// Next real turn resumes warming automatically.
		parked.warmer.start(request(), current);
		expect(parked.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(parked.calls).toHaveLength(4);
		parked.warmer.cancel();
	});

	it("respects custom idle cutoffs including zero and rejects late timers past the cutoff", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const custom = fakeRuntime({ branch: branchWithPrompt(400_000), maxIdleAgeMs: 10 * 60_000 });
		custom.warmer.start(request(), current);
		custom.warmer.onAgentSettled();
		// 4.5m and 9m fit within 10m; 13.5m exceeds 10m.
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(custom.calls).toHaveLength(2);
		expect(custom.warmer.status).toEqual({
			state: "inactive",
			reason: "10-minute idle safety limit reached",
		});

		const zeroIdle = fakeRuntime({ branch: branchWithPrompt(400_000), maxIdleAgeMs: 0 });
		zeroIdle.warmer.start(request(), current);
		zeroIdle.warmer.onAgentSettled();
		expect(zeroIdle.warmer.status).toEqual({
			state: "inactive",
			reason: "idle cache warming cutoff reached",
		});
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(zeroIdle.calls).toHaveLength(0);
	});

	it("measures the idle cutoff from when a long turn settles rather than when the turn started", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const longTurn = fakeRuntime({ branch: branchWithPrompt(400_000) });
		longTurn.warmer.start(request(), current);

		// Simulate an 18-minute active streaming turn (4 streaming warms at 4.5m, 9m, 13.5m, 18m).
		await vi.advanceTimersByTimeAsync(18 * 60_000);
		expect(longTurn.calls).toHaveLength(4);
		expect(longTurn.warmer.status.state).toBe("scheduled");

		// Settling at 18m refreshes the idle baseline so the 15-minute idle cutoff starts at 18m.
		longTurn.warmer.onAgentSettled();
		expect(longTurn.warmer.status.state).toBe("scheduled");

		// Post-settle idle warms occur at 22.5m, 27m, and 31.5m (within 18m + 15m = 33m), then stop.
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(longTurn.calls).toHaveLength(7);
		expect(longTurn.warmer.status).toEqual({
			state: "inactive",
			reason: "15-minute idle safety limit reached",
		});

		// With maxIdleAgeMs = 0, settling after an 18-minute turn still stops immediately.
		const zeroAfterLongTurn = fakeRuntime({ branch: branchWithPrompt(400_000), maxIdleAgeMs: 0 });
		zeroAfterLongTurn.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(18 * 60_000);
		expect(zeroAfterLongTurn.calls).toHaveLength(4);
		zeroAfterLongTurn.warmer.onAgentSettled();
		expect(zeroAfterLongTurn.warmer.status).toEqual({
			state: "inactive",
			reason: "idle cache warming cutoff reached",
		});
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});
