import { expect, it } from "vitest";
import { createHarness } from "./harness.ts";

it.each([false, true])("navigation recalls only visible custom messages (display=%s)", async (display) => {
	const harness = await createHarness();
	try {
		const parent = harness.sessionManager.appendMessage({ role: "user", content: "My request", timestamp: 1 });
		const target = harness.sessionManager.appendCustomMessageEntry("test.notice", "Internal update", display);
		harness.sessionManager.appendMessage({ role: "user", content: "Later request", timestamp: 2 });
		const result = await harness.session.navigateTree(target, { summarize: false });
		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe(display ? "Internal update" : undefined);
		expect(harness.sessionManager.getLeafId()).toBe(display ? parent : target);
	} finally {
		harness.cleanup();
	}
});
