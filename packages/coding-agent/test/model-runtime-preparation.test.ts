import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function runtime() {
	const value = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	value.registerProvider("example", {
		api: "openai-responses",
		baseUrl: "https://example.invalid/v1",
		apiKey: "sk-configured",
		headers: { "x-provider": "configured" },
		models: [
			{
				id: "example",
				name: "Example",
				reasoning: true,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 1000,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
				compat: { preparation: "cache", supportsExplicitPromptCacheMode: true },
				headers: { "x-model": "configured" },
			},
		],
	});
	return value;
}

function completed() {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "prepared", status: "completed", output: [] } })}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(async () => {
	await cleanupSessionResources("runtime-example");
});

describe("ModelRuntime preparation", () => {
	it("uses the configured API and fully assembled headers without generating", async () => {
		const value = await runtime();
		const model = value.getModel("example", "example")!;
		let transforms = 0;
		const prepared = await value.prepareSimple(
			model,
			{ messages: [] },
			{
				sessionId: "runtime-example",
				headers: { "x-request": "configured" },
				transformHeaders: (headers) => {
					transforms++;
					return { ...headers, "x-transform": "configured" };
				},
				fetch: async (_input, init) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBe("Bearer sk-configured");
					for (const name of ["x-provider", "x-model", "x-request", "x-transform"])
						expect(headers.get(name)).toBe("configured");
					expect(JSON.parse(String(init?.body))).toMatchObject({ prompt_cache_options: { prewarm: true } });
					return completed();
				},
			},
		);
		expect(prepared.responseId).toBe("prepared");
		expect(transforms).toBe(1);
	});

	it("routes a virtual model first and does not forward another provider's credentials", async () => {
		const value = await runtime();
		const physical = value.getModel("example", "example")!;
		value.registerVirtualModel({
			provider: "router",
			id: "route",
			name: "Route",
			thinkingLevels: ["high"],
			route: () => ({ model: physical, thinkingLevel: "high" }),
		});
		const virtual = value.getModel("router", "route")!;
		await value.prepareSimple(
			virtual,
			{ messages: [] },
			{
				apiKey: "do-not-forward",
				headers: { "x-private-route": "do-not-forward" },
				sessionId: "runtime-example",
				fetch: async (_input, init) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBe("Bearer sk-configured");
					expect(headers.has("x-private-route")).toBe(false);
					expect(JSON.parse(String(init?.body))).toMatchObject({
						model: "example",
						reasoning: { effort: "high" },
						prompt_cache_options: { prewarm: true },
					});
					return completed();
				},
			},
		);
	});

	it("refuses to bypass an extension's custom stream implementation", async () => {
		const value = await runtime();
		let calls = 0;
		value.registerProvider("example", {
			api: "openai-responses",
			streamSimple: () => {
				calls++;
				throw new Error("Unexpected generation");
			},
		});
		await expect(value.prepareSimple(value.getModel("example", "example")!, { messages: [] })).rejects.toThrow(
			"Custom stream override",
		);
		expect(calls).toBe(0);
	});
});
