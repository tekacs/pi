import assert from "node:assert";
import { describe, it } from "node:test";
import { extractAnsiCode, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("ECMA-48 CSI final-byte scanning in ansiCodeLength", () => {
	it("stops immediately at the first ECMA-48 CSI final byte (0x40..=0x7E) such as '{'", () => {
		const malformed = "\x1b[{key} value m";
		const extracted = extractAnsiCode(malformed, 0);
		assert.deepStrictEqual(extracted, { code: "\x1b[{", length: 3 });
		// Only `\x1b[{` is treated as CSI; `key} value m` remains visible instead of being swallowed up to `m`.
		assert.strictEqual(visibleWidth(malformed), "key} value m".length);
	});

	it("does not swallow prose after malformed CSI sequences during wrapTextWithAnsi", () => {
		const text = "\x1b[{tag} alpha beta gamma m";
		const wrapped = wrapTextWithAnsi(text, 12);
		for (const line of wrapped) {
			assert.ok(visibleWidth(line) <= 12, `line exceeded width 12: ${JSON.stringify(line)}`);
		}
		assert.strictEqual(
			wrapped.map((line) => line.replace(/\x1b\[[^\x40-\x7e]*[\x40-\x7e]/g, "")).join(" "),
			"tag} alpha beta gamma m",
		);
	});

	it("rejects control bytes interrupting a CSI sequence so a following valid SGR is still parsed", () => {
		const interrupted = "\x1b[\x1b[31mred\x1b[0m";
		assert.strictEqual(extractAnsiCode(interrupted, 0), null);
		assert.deepStrictEqual(extractAnsiCode(interrupted, 2), { code: "\x1b[31m", length: 5 });
		// Leading `\x1b[` has lone ESC (width 0) + `[` (width 1) + `red` (width 3) = 4.
		assert.strictEqual(visibleWidth(interrupted), 4);
	});

	it("handles standard SGR and non-SGR ECMA-48 CSI sequences accurately", () => {
		assert.deepStrictEqual(extractAnsiCode("\x1b[1;38;2;134;239;172mhi", 0), {
			code: "\x1b[1;38;2;134;239;172m",
			length: 21,
		});
		assert.deepStrictEqual(extractAnsiCode("\x1b[?25ltext", 0), {
			code: "\x1b[?25l",
			length: 6,
		});
		assert.deepStrictEqual(extractAnsiCode("\x1b[2Atext", 0), {
			code: "\x1b[2A",
			length: 4,
		});
	});
});
