import { fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import { Harness, type LiveState, type ProgressPolicy } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, textOf, waitFor } from "./chat-support.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";

function controlled() {
	const steps = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const reached = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const events = async function* () {
		yield { type: "start", partial: fauxAssistantMessage([], { stopReason: "pending" }) };
		for (const [i, text] of ["prefix", "leading", "later"].entries()) {
			yield {
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: fauxAssistantMessage(text, { stopReason: "pending" }),
			};
			reached[i]!.resolve();
			await steps[i]!.promise;
		}
	};
	const stream = {
		[Symbol.asyncIterator]: events,
		result: async () => fauxAssistantMessage("final"),
	} as unknown as ReturnType<Models["streamSimple"]>;
	return { stream, steps, reached };
}

async function fixture(leading?: ProgressPolicy["partialLeading"]) {
	const setup = chatSetup();
	const run = controlled();
	const models = new Proxy(setup.models, {
		get(target, name) {
			if (name === "streamSimple") return () => run.stream;
			const value = Reflect.get(target, name, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const timers = new Set<() => void>();
	const reports: unknown[] = [];
	const storage = new ControlledStorage();
	const harness = await Harness.open(
		storage,
		{
			models,
			registry: setup.registry,
			settings: { ...setup.settings, progress: { partialIntervalMs: 5000, partialLeading: leading } },
			setTimer(callback, delay) {
				if (delay !== 5000) {
					const timer = setTimeout(callback, delay);
					timer.unref();
					return () => clearTimeout(timer);
				}
				timers.add(callback);
				return () => {
					timers.delete(callback);
				};
			},
			onReport: (_error, info) => {
				reports.push(info);
			},
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const values: string[] = [];
	harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "document" || change.record.kind !== "pi.live" || !change.value) continue;
			const text = textOf((change.value as LiveState).generation?.message);
			if (text) values.push(text);
		}
	});
	const submission = await root.submit({ type: "input", content: "synthetic" }, context);
	await run.reached[0]!.promise;
	const tick = () => {
		for (const callback of [...timers]) {
			timers.delete(callback);
			callback();
		}
	};
	const close = async () => {
		for (const step of run.steps) step.resolve();
		await submission.wait(context);
		await harness.close(context);
	};
	return { ...run, storage, harness, root, values, timers, tick, reports, close };
}

describe("leading partial policy", () => {
	it("cancels the pending interval for one selected partial, then restores coalescing", async () => {
		const seen: number[] = [];
		const f = await fixture((message, id) => {
			seen.push(id);
			return textOf(message) === "leading";
		});
		try {
			expect(f.values).toEqual([]);
			expect(f.timers.size).toBe(1);
			f.steps[0]!.resolve();
			await f.reached[1]!.promise;
			await waitFor(() => f.values.includes("leading"));
			expect(f.timers.size).toBe(0);
			f.steps[1]!.resolve();
			await f.reached[2]!.promise;
			await flush();
			expect(f.values).toEqual(["leading"]);
			expect(seen).toEqual([f.root.id, f.root.id]);
			expect(f.timers.size).toBe(1);
			f.tick();
			await waitFor(() => f.values.includes("later"));
		} finally {
			await f.close();
		}
	});

	it("waits for the writer already in flight, then commits the selected latest partial without another interval", async () => {
		const f = await fixture((message) => textOf(message) === "leading");
		try {
			const gate = f.storage.holdCommits();
			f.tick();
			await gate.entered;
			f.steps[0]!.resolve();
			await f.reached[1]!.promise;
			f.steps[1]!.resolve();
			await f.reached[2]!.promise;
			expect(f.values).toEqual([]);
			gate.release();
			await waitFor(() => f.values.includes("later"));
			expect(f.values).toEqual(["prefix", "later"]);
			expect(f.timers.size).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("contains a throwing policy once and preserves the interval and terminal result", async () => {
		let calls = 0;
		const f = await fixture(() => {
			calls++;
			throw new Error("synthetic policy failure");
		});
		try {
			f.steps[0]!.resolve();
			await f.reached[1]!.promise;
			f.steps[1]!.resolve();
			await f.reached[2]!.promise;
			expect(calls).toBe(1);
			expect(f.values).toEqual([]);
			expect(f.reports).toContainEqual(expect.objectContaining({ type: "host_error", callback: "partialLeading" }));
			f.tick();
			await waitFor(() => f.values.includes("later"));
		} finally {
			await f.close();
		}
	});

	it("keeps default trailing-only commits and disarms its timer at terminal settlement", async () => {
		const f = await fixture();
		f.steps[0]!.resolve();
		await f.reached[1]!.promise;
		f.steps[1]!.resolve();
		await f.reached[2]!.promise;
		expect(f.values).toEqual([]);
		await f.close();
		expect(f.timers.size).toBe(0);
		expect(f.values).not.toContain("later");
	});
});
