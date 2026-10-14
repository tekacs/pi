import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("session append publication", () => {
	const appenders = {
		message: (session: SessionManager) => session.appendMessage({ role: "user", content: "next", timestamp: 2 }),
		custom: (session: SessionManager) => session.appendCustomEntry("example", { value: 1 }),
		customMessage: (session: SessionManager) => session.appendCustomMessageEntry("example", "next", false),
	};

	for (const [kind, append] of Object.entries(appenders)) {
		it(`does not publish a failed ${kind} append and fences later writes`, () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-append-"));
			try {
				const session = SessionManager.create(dir, dir);
				const parent = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
				const file = session.getSessionFile()!;
				const before = readFileSync(file, "utf8");
				const entries = session.getEntries();
				renameSync(file, `${file}.saved`);
				mkdirSync(file);

				expect(() => append(session)).toThrow("reopen before continuing");
				expect(session.getEntries()).toEqual(entries);
				expect(session.getEntryCount()).toBe(entries.length);
				expect(session.getLeafId()).toBe(parent);
				expect(session.getBranch()).toEqual(entries);
				expect(session.getChildren(parent)).toEqual([]);

				rmSync(file, { recursive: true });
				renameSync(`${file}.saved`, file);
				expect(() => session.appendCustomEntry("later")).toThrow("reopen before continuing");
				expect(readFileSync(file, "utf8")).toBe(before);
				const reopened = SessionManager.open(file);
				const id = append(reopened);
				expect(reopened.getLeafId()).toBe(id);
				expect(SessionManager.open(file).getEntry(id)).toEqual(reopened.getEntry(id));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("keeps setup entries but rejects a failed first conversation append", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-first-append-"));
		try {
			const session = SessionManager.create(dir, dir);
			const setup = session.appendModelChange("example", "model");
			const entries = session.getEntries();
			const file = session.getSessionFile()!;
			mkdirSync(file);
			expect(() => appenders.message(session)).toThrow("reopen before continuing");
			expect(session.getEntries()).toEqual(entries);
			expect(session.getLeafId()).toBe(setup);
			expect(session.getChildren(setup)).toEqual([]);
			rmSync(file, { recursive: true });
			expect(() => appenders.message(session)).toThrow("reopen before continuing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
