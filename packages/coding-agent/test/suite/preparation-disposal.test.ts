import { sessionOperation } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness } from "./harness.ts";

it("session disposal joins preparation setup before reporting completion", async () => {
	const harness = await createHarness();
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const operation = sessionOperation(harness.session.sessionId, undefined, async ({ signal }) => {
		entered();
		await pending;
		signal.throwIfAborted();
	}).catch((error: unknown) => error);
	try {
		await started;
		let disposed = false;
		const disposal = harness.session.dispose().then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);
		release();
		await disposal;
		expect(await operation).toBeInstanceOf(Error);
		expect(harness.session.messages).toEqual([]);
	} finally {
		release();
		await harness.session.dispose();
		harness.cleanup();
	}
});
