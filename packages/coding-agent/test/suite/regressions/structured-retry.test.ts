import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const opaque = '{"detail":"Unable to verify Daybreak Blue access. Please try again."}';
function failure(code?: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: opaque }),
		failure: { status: 503, ...(code ? { code } : {}) },
	};
}

// Regression for okou-ai/okou#35577 / PR #35819, exercised through Pi's real session retry loop.
describe("structured session retries", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup() {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } } });
		harnesses.push(harness);
		return harness;
	}

	it("retries an opaque structured failure and finishes the turn", async () => {
		const harness = await setup();
		harness.setResponses([failure(), fauxAssistantMessage("recovered")]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered" }],
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("exhausts the budget and persists the final structured error", async () => {
		const harness = await setup();
		harness.setResponses([failure(), failure(), failure(), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2 }]);
		const messages = JSON.parse(
			JSON.stringify(harness.sessionManager.buildSessionContext().messages),
		) as AssistantMessage[];
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: opaque, failure: { status: 503 } });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not spend session retries on a terminal code behind 503", async () => {
		const harness = await setup();
		harness.setResponses([failure("invalid_api_key"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
