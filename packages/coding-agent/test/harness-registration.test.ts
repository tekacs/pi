import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, HarnessStream } from "../src/core/extensions/types.ts";

const stream: HarnessStream = () => {
	throw new Error("Not called by registration tests");
};

describe("harness registration during extension loading", () => {
	it("commits registrations only after the factory succeeds", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			(pi) => {
				pi.registerHarness("test-provider", stream);
				expect(runtime.pendingHarnessRegistrations).toEqual([]);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		expect(runtime.pendingHarnessRegistrations).toEqual([
			{ name: "test-provider", stream, extensionPath: "<inline>" },
		]);
	});

	it("discards failed factory registrations and rejects its retained API", async () => {
		const runtime = createExtensionRuntime();
		let captured: ExtensionAPI | undefined;
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					captured = pi;
					pi.registerHarness("test-provider", stream);
					throw new Error("factory failed");
				},
				process.cwd(),
				createEventBus(),
				runtime,
			),
		).rejects.toThrow("factory failed");
		expect(runtime.pendingHarnessRegistrations).toEqual([]);
		expect(() => captured!.registerHarness("test-provider", stream)).toThrow("failed to load");
	});
});
