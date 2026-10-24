import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("ANSI-neutral wrapping boundaries", () => {
	it("keeps styled whitespace a separator rather than a word", () => {
		const source = "  alpha beta (Example::Items key) (Example::Title)";
		const styled = source.replace(/\S+/g, (word) => `\x1b[36m${word}\x1b[39m`);
		for (const width of [8, 12, 20, 40]) {
			const lines = wrapTextWithAnsi(styled, width);
			assert.deepEqual(lines.map(stripTerminalSequences), wrapTextWithAnsi(source, width));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});

	it("preserves pending styles after dropping whitespace at a line break", () => {
		const source = "alpha\x1b[31m beta\x1b[39m gamma";
		const lines = wrapTextWithAnsi(source, 5);
		assert.deepEqual(lines.map(stripTerminalSequences), ["alpha", "beta", "gamma"]);
		assert.ok(lines[1].includes("\x1b[31m"));
	});
});
