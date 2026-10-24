import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const safe = fauxAssistantMessage([], {
	stopReason: "error",
	errorMessage: "not dispatched",
});
const ambiguous = fauxAssistantMessage([], {
	stopReason: "error",
	errorMessage: "503 Service Unavailable",
});

describe("host generation retry classifier", () => {
	it("replaces rather than widens the built-in classification", async () => {
		for (const [message, expected, calls] of [
			[safe, "done", 2],
			[ambiguous, "unanswered", 1],
		] as const) {
			const setup = chatSetup();
			setup.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
			setup.settings.retryable = (value) =>
				value.errorMessage === "not dispatched";
			setup.faux.setResponses([message, fauxAssistantMessage("ok")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			try {
				const submission = await root.submit(
					{ type: "input", content: "synthetic" },
					context,
				);
				expect((await submission.wait(context)).status).toBe(expected);
				expect(setup.faux.state.callCount).toBe(calls);
			} finally {
				await harness.close(context);
			}
		}
	});

	it("retains exhaustion and skips classification outside the retry budget", async () => {
		const setup = chatSetup();
		let decisions = 0;
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		setup.settings.retryable = () => {
			decisions++;
			return true;
		};
		setup.faux.setResponses([safe, safe, fauxAssistantMessage("never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const submission = await root.submit(
				{ type: "input", content: "synthetic" },
				context,
			);
			expect(await submission.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "model_error",
				detail: "not dispatched",
			});
			expect(setup.faux.state.callCount).toBe(2);
			expect(decisions).toBe(1);
		} finally {
			await harness.close(context);
		}
	});

	it("reports a throwing classifier and fails closed with the original cause", async () => {
		const setup = chatSetup();
		setup.settings.retryable = () => {
			throw new Error("classifier failed");
		};
		setup.faux.setResponses([ambiguous, fauxAssistantMessage("never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const submission = await root.submit(
				{ type: "input", content: "synthetic" },
				context,
			);
			expect(await submission.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "model_error",
				detail: "503 Service Unavailable",
			});
			expect(setup.faux.state.callCount).toBe(1);
			expect(setup.reports).toContainEqual(new Error("classifier failed"));
		} finally {
			await harness.close(context);
		}
	});

	it("does not classify disabled retries, aborts or context overflow", async () => {
		for (const [message, enabled] of [
			[safe, false],
			[fauxAssistantMessage([], { stopReason: "aborted" }), true],
			[
				fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: "maximum context length exceeded",
				}),
				true,
			],
		] as const) {
			const setup = chatSetup();
			let decisions = 0;
			setup.settings.retry = { enabled, maxRetries: 1, baseDelayMs: 1 };
			setup.settings.compaction = { enabled: false };
			setup.settings.retryable = () => {
				decisions++;
				return true;
			};
			setup.faux.setResponses([message, fauxAssistantMessage("never")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			try {
				const submission = await root.submit(
					{ type: "input", content: "synthetic" },
					context,
				);
				expect((await submission.wait(context)).status).toBe("unanswered");
				expect(setup.faux.state.callCount).toBe(1);
				expect(decisions).toBe(0);
			} finally {
				await harness.close(context);
			}
		}
	});

	it("persists the native retry checkpoint across reopen without another input", async () => {
		const setup = chatSetup();
		let now = 1000;
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1000 };
		setup.settings.retryable = (value) =>
			value.errorMessage === "not dispatched";
		setup.faux.setResponses([safe, fauxAssistantMessage("recovered")]);
		const storage = new ControlledStorage();
		let harness = await Harness.open(
			storage,
			{
				models: setup.models,
				registry: setup.registry,
				settings: setup.settings,
				now: () => now,
				onWake: () => {},
			},
			context,
		);
		const root = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});
		const submission = await root.submit(
			{ type: "input", content: "synthetic", requestId: "one" },
			context,
		);
		await waitFor(
			async () =>
				(await harness.snapshot(LiveDoc, root.id, context))?.generation
					?.retry !== undefined,
		);
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
		now = 3000;
		harness = await Harness.open(
			storage.reopen(),
			{
				models: setup.models,
				registry: setup.registry,
				settings: setup.settings,
				now: () => now,
				onWake: () => {},
			},
			context,
		);
		try {
			harness.resume();
			const retained = await harness.submission(submission.id, context);
			if (retained === undefined) throw new Error("Missing retained submission");
			expect((await retained.wait(context)).status).toBe("done");
			expect(setup.faux.state.callCount).toBe(2);
		} finally {
			await harness.close(context);
		}
	});

	it("applies the same host classifier to compaction without widening provider retries", async () => {
		for (const [message, expected, calls] of [
			[safe, "completed", 4],
			[ambiguous, "failed", 3],
		] as const) {
			const setup = chatSetup();
			setup.settings.compaction = { enabled: false, keepRecentTokens: 1 };
			setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
			setup.settings.retryable = (value) =>
				value.errorMessage === "not dispatched";
			setup.faux.setResponses([
				fauxAssistantMessage("a".repeat(2000)),
				fauxAssistantMessage("b".repeat(2000)),
				message,
				fauxAssistantMessage("summary"),
			]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			try {
				await (
					await root.submit(
						{ type: "input", content: "first".repeat(400) },
						context,
					)
				).wait(context);
				await (
					await root.submit(
						{ type: "input", content: "second".repeat(400) },
						context,
					)
				).wait(context);
				const task = await root.compact(undefined, context);
				expect(
					(await harness.waitForTask(task, context)).state.outcome.status,
				).toBe(expected);
				expect(setup.faux.state.callCount).toBe(calls);
			} finally {
				await harness.close(context);
			}
		}
	});

	it("cancels the sleeping generation without calling the provider again", async () => {
		const setup = chatSetup();
		setup.settings.retry = {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 60_000,
		};
		setup.settings.retryable = () => true;
		setup.faux.setResponses([safe, fauxAssistantMessage("never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const submission = await root.submit(
				{ type: "input", content: "synthetic" },
				context,
			);
			await waitFor(
				async () =>
					(await harness.snapshot(LiveDoc, root.id, context))?.generation
						?.retry !== undefined,
			);
			await root.abort(context);
			expect(await submission.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "aborted",
			});
			expect(setup.faux.state.callCount).toBe(1);
		} finally {
			await harness.close(context);
		}
	});
});
