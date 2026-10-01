import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function runtime() {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "global" } }),
		modelsPath: null,
		refreshOnCreate: false,
	});
}

describe("scoped request authentication", () => {
	it("isolates runtimes, captures in-flight selections, restores native auth on disposal", async () => {
		const a = await runtime();
		const b = await runtime();
		const registry = new ModelRegistry(a);
		let account = "one";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const dispose = registry.registerAuthResolver("anthropic", async () => {
			const selected = account;
			await gate;
			return { auth: { apiKey: selected } };
		});
		const pending = a.getAuth("anthropic");
		account = "two";
		release();
		expect((await pending)?.auth.apiKey).toBe("one");
		expect((await a.getAuth("anthropic"))?.auth.apiKey).toBe("two");
		expect((await registry.getNativeAuth("anthropic"))?.auth.apiKey).toBe("global");
		expect((await a.getAuth("anthropic"))?.auth.apiKey).toBe("two");
		expect((await b.getAuth("anthropic"))?.auth.apiKey).toBe("global");
		expect(() => registry.registerAuthResolver("anthropic", async () => undefined)).toThrow("already bound");
		dispose();
		expect((await a.getAuth("anthropic"))?.auth.apiKey).toBe("global");
		dispose();
	});

	it("delegates only on undefined, propagates failures and cancellation", async () => {
		const value = await runtime();
		let dispose = value.registerAuthResolver("anthropic", async () => undefined);
		expect((await value.getAuth("anthropic"))?.auth.apiKey).toBe("global");
		dispose();
		dispose = value.registerAuthResolver("anthropic", async () => {
			throw new Error("selected account expired");
		});
		await expect(value.getAuth("anthropic")).rejects.toThrow("selected account expired");
		expect((await new ModelRegistry(value).getNativeAuth("anthropic"))?.auth.apiKey).toBe("global");
		expect((await value.getAuth("anthropic", { apiKey: "explicit" }))?.auth.apiKey).toBe("explicit");
		dispose();
		const controller = new AbortController();
		value.registerAuthResolver("anthropic", async ({ signal }) => {
			expect(signal).toBeInstanceOf(AbortSignal);
			return new Promise(() => {});
		});
		const pending = value.getAuth("anthropic", { signal: controller.signal });
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
	});

	it("feeds nested runtime streams and preserves model headers", async () => {
		const value = await runtime();
		let key: string | undefined;
		value.registerProvider("account-fixture", {
			api: "openai-completions",
			baseUrl: "https://unused.invalid",
			apiKey: "global",
			models: [
				{
					id: "fixture",
					name: "Fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
					headers: { "x-model": "present" },
				},
			],
			streamSimple: (_model, _context, options) => {
				key = options?.apiKey;
				expect(options?.headers?.["x-model"]).toBe("present");
				throw new Error("fixture captured request without network");
			},
		});
		value.registerAuthResolver("account-fixture", async () => ({ auth: { apiKey: "thread" } }));
		const model = value.getModel("account-fixture", "fixture")!;
		await new ModelRegistry(value).streamSimple(model, { messages: [] }).result();
		expect(key).toBe("thread");
	});
});
