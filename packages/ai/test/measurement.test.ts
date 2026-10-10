import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import { createFauxCore } from "../src/providers/faux.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const faux = createFauxCore({});
const context = normalizeContext({ messages: [{ role: "user", content: "Synthetic input", timestamp: 1 }] });

describe("request purpose", () => {
	it.each([undefined, "inference", "measurement"] as const)(
		"preserves %s through simple option conversion",
		(purpose) => {
			const signal = new AbortController().signal;
			const options = buildBaseOptions(faux.getModel(), context, {
				purpose,
				signal,
				sessionId: "session",
				cacheKey: "prefix",
				maxTokens: 1,
			});
			expect(options).toMatchObject({ purpose, signal, sessionId: "session", cacheKey: "prefix", maxTokens: 1 });
		},
	);
});
