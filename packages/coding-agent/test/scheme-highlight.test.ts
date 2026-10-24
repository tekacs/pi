import { performance } from "node:perf_hooks";
import {
	Markdown,
	resetCapabilitiesCache,
	setCapabilities,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	getMarkdownTheme,
	highlightCode,
	initTheme,
	setTerminalColors,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { isSchemeLanguage, SchemeHighlighter, type SchemeRole, schemeSpans } from "../src/utils/scheme-highlight.ts";
import { isSchemeNumber } from "../src/utils/scheme-reader.ts";
import { highlight, loadAllHighlightLanguages, supportsLanguage } from "../src/utils/syntax-highlight.ts";

const sample =
	String.raw`;; A small formatter
(define (describe item)
  (let* ([label (string-append "item: " item)]
         [limit 12])
    (list #:label label #:limit limit Example::Title '(alpha (beta gamma)))))
(list "not (structure)" #\( |name(with)paren|
      #; (discarded (datum))
      ` +
	'`(data ,(describe "界🙂é") ,@(list "x")))\n' +
	`#| outer ( #| inner ) |# still comment |#`;

function roles(source: string, role: SchemeRole): string[] {
	return schemeSpans(source)
		.filter((span) => span.role === role)
		.map((span) => source.slice(span.start, span.end));
}

beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	setTerminalColors({});
	initTheme("dark");
});
afterEach(() => {
	setTerminalColors({});
	resetCapabilitiesCache();
});

describe("Scheme reader roles", () => {
	it("recognizes only explicit Scheme/Steel language names, before deferred grammars", async () => {
		for (const name of ["scheme", "scm", "ss", "steel", "SCHEME", " Steel "]) {
			expect(isSchemeLanguage(name)).toBe(true);
			expect(supportsLanguage(name)).toBe(true);
			expect(highlightCode("(define x 1)", name).join("\n")).toContain("\x1b[");
		}
		for (const name of [undefined, "", "text", "lisp", "clojure", "scheme-ish", "scheme title"])
			expect(isSchemeLanguage(name)).toBe(false);
		expect(highlightCode("(define x 1)").join("\n")).toBe(theme.fg("mdCodeBlock", "(define x 1)"));
		await loadAllHighlightLanguages();
		expect(highlight("(define x 1)", { language: "scheme" })).toBe("(define x 1)");
	});

	it("distinguishes core forms, calls, binders, references and named let", () => {
		const source = "(define (f x . rest) (let loop ([n x]) (if n (loop n) rest)))";
		expect(roles(source, "binding")).toEqual(["f", "x", "rest", "loop", "n"]);
		expect(roles(source, "form")).toEqual(["define", "let", "if"]);
		expect(roles(source, "call")).toEqual(["loop"]);
		expect(roles("(lambda args args) (define-values (a b) (values 1 2))", "binding")).toEqual(["args", "a", "b"]);
		expect(roles("(define f (lambda (x y) (+ x y)))", "binding")).toEqual(["f", "x", "y"]);
		expect(roles("(mystery (slot value))", "binding")).toEqual([]);
		expect(roles("(mystery (slot value))", "call")).toEqual(["slot"]);
	});

	it("does not see structural characters or keywords inside reader literals", () => {
		const source = String.raw`(list "a\"( #:x" #\( #\) #\; #\space |a(b)| a\(b |#:x|)`;
		expect(roles(source, "keyword")).toEqual([]);
		expect(roles(source, "call")).toEqual([]);
		expect(roles(source, "string")).toEqual([
			String.raw`"a\"( #:x"`,
			String.raw`#\(`,
			String.raw`#\)`,
			String.raw`#\;`,
			String.raw`#\space`,
		]);
		const brackets = schemeSpans(source).filter((span) => span.depth !== undefined);
		expect(brackets.map((span) => [source.slice(span.start, span.end), span.depth])).toEqual([
			["(", 0],
			[")", 0],
		]);
	});

	it("reads nested block and datum comments as trivia, including nested discard", () => {
		const source = "(f #| one #| two |# three |# #; #; (a) '(b) live)";
		expect(roles(source, "call")).toEqual([]);
		expect(roles(source, "comment").join("")).toBe("#| one #| two |# three |##; #; (a) '(b)");
		expect(roles(source, "plain").join("")).toContain("live");
		expect(roles("(define #;ignore name 1)", "binding")).toEqual(["name"]);
		expect(roles("#; (x #; y z) (live)", "form")).toEqual(["live"]);
		expect(roles("#!fold-case (define x 1)", "binding")).toEqual(["x"]);
		expect(roles("(define#|comment|# x 1)", "binding")).toEqual(["x"]);
	});

	it("tracks quote and quasiquote levels, including long forms and vectors", () => {
		for (const source of ["'(f (g x))", "(quote (f (g x)))", "#(f (g x))", "#u8(1 2 3)"]) {
			expect(roles(source, "call")).toEqual([]);
			expect(roles(source, "binding")).toEqual([]);
		}
		expect(roles("`(data ,(f x) ,@(g x))", "call")).toEqual(["f", "g"]);
		expect(roles("`(data `(inner ,(quiet x) ,,(active x)))", "call")).toEqual(["active"]);
		expect(roles("(quasiquote (data (unquote (f x))))", "call")).toEqual(["f"]);
		expect(roles("'`(data ,(quiet x))", "call")).toEqual([]);
	});

	it("pairs delimiter depth and tolerates unmatched closing/opening delimiters", () => {
		const source = ")(a [b {c}]) ((";
		const spans = schemeSpans(source).filter((span) => span.depth !== undefined);
		expect(spans.map((span) => span.depth)).toEqual([0, 1, 2, 2, 1, 0, 0, 1]);
		expect(schemeSpans("([)]").every((span) => span.depth === undefined || span.depth >= 0)).toBe(true);
		expect(() => schemeSpans(`${"(".repeat(20000)}x${")".repeat(20000)}`)).not.toThrow();
	});

	it("classifies complete numeric atoms rather than prefixes of identifiers", () => {
		for (const atom of ["12", "-4/5", ".5", "2e-3", "1+2i", "+i", "2@3", "+inf.0", "#e#x1f", "#b101", "#o17", "#d12"])
			expect(isSchemeNumber(atom), atom).toBe(true);
		for (const atom of ["i", "123abc", "-", "+", "#xnope", "#b102"]) expect(isSchemeNumber(atom), atom).toBe(false);
	});
});

describe("source preservation", () => {
	it("covers every source boundary of representative incomplete reader forms", () => {
		const sources = [
			sample,
			String.raw`(f "line
continued\"" |escaped\|symbol| #; '(x) #| a #| b |#`,
			"'`(a ,@(b) #;#;a b c)",
			"([)] #\\ ",
			'(define x\r\n\t"&<>界🙂é")',
		];
		const format = new SchemeHighlighter();
		const styles = Object.fromEntries(
			[
				"form",
				"call",
				"binding",
				"keyword",
				"qualified",
				"constructor",
				"plain",
				"data",
				"number",
				"string",
				"comment",
				"punctuation",
				...Array.from({ length: 6 }, (_, i) => `depth${i}`),
			].map((role) => [`scheme.${role}`, (text: string) => `\x1b[36m${text}\x1b[39m`]),
		);
		for (const source of sources) {
			for (let end = 0; end <= source.length; end++) {
				const prefix = source.slice(0, end);
				const spans = schemeSpans(prefix);
				let position = 0;
				for (const span of spans) {
					expect(span.start).toBe(position);
					expect(span.end).toBeGreaterThan(span.start);
					position = span.end;
				}
				expect(position).toBe(prefix.length);
				const rendered = format.highlight(prefix, styles);
				expect(stripTerminalSequences(rendered)).toBe(prefix);
				for (const line of rendered.split("\n"))
					if (line.includes("\x1b[")) expect(line.endsWith("\x1b[39m")).toBe(true);
			}
		}
	});

	it("reconstructs deterministic malformed reader input without hanging", () => {
		let seed = 41;
		const alphabet = "()[]{}#;|'` ,@\\\"abc\n\t";
		for (let n = 0; n < 200; n++) {
			let source = "";
			for (let i = 0; i < 200; i++) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				source += alphabet[seed % alphabet.length];
			}
			expect(
				schemeSpans(source)
					.map((span) => source.slice(span.start, span.end))
					.join(""),
			).toBe(source);
		}
	});

	it("keeps display source and original message copy separate", () => {
		const text = `Prose (not code).\n\n\`\`\`scheme\n${sample}\n\`\`\``;
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "openai-responses" as const,
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
		const original = structuredClone(message);
		const component = new AssistantMessageComponent(message);
		component.updateContent(message, true);
		const dark = component.render(80).join("\n");
		initTheme("light");
		component.invalidate();
		const light = component.render(80).join("\n");
		expect(light).not.toBe(dark);
		expect(stripTerminalSequences(light)).toBe(stripTerminalSequences(dark));
		expect(message).toEqual(original);
		const session = { messages: [message] };
		expect(AgentSession.prototype.getLastAssistantText.call(session as unknown as AgentSession)).toBe(text);
	});
});

describe("themed fences and terminal layout", () => {
	it("repaints cached source when the underlying theme or terminal defaults change", () => {
		const md = getMarkdownTheme();
		const code = "(define (f x) (list #:x x '(data)))";
		const dark = md.highlightCode?.(code, "scheme");
		initTheme("light");
		const light = md.highlightCode?.(code, "scheme");
		expect(light).not.toEqual(dark);
		expect(light).toEqual(highlightCode(code, "scheme"));
		expect(light?.map(stripTerminalSequences)).toEqual([code]);
		setTerminalColors({ foreground: { r: 220, g: 226, b: 236 }, background: { r: 17, g: 19, b: 24 } });
		initTheme("system");
		const system = md.highlightCode?.(code, "scheme");
		setTerminalColors({ foreground: { r: 30, g: 40, b: 50 }, background: { r: 240, g: 240, b: 240 } });
		expect(md.highlightCode?.(code, "scheme")).not.toEqual(system);
	});

	it.each([true, false])("uses the active color mode (truecolor=%s)", (trueColor) => {
		setCapabilities({ images: null, trueColor, hyperlinks: false });
		initTheme("dark");
		const code = "(define (f x) (list #:x x))";
		const result = highlightCode(code, "scheme").join("\n");
		expect(result).toContain(trueColor ? "\x1b[38;2;" : "\x1b[38;5;");
		expect(stripTerminalSequences(result)).toBe(code);
	});

	it("preserves visible layout through wrapping, quoting, lists and partial fences", () => {
		for (const width of [20, 40, 80])
			for (const name of ["dark", "light", "system"]) {
				initTheme(name);
				const md = getMarkdownTheme();
				const plain = { ...md, highlightCode: (code: string) => code.split("\n") };
				for (const source of [
					`\`\`\`scheme\n${sample}\n\`\`\``,
					'> ```steel\n> (f "界🙂é")\n> ```',
					'- Example\n  ```scheme\n  (f "long-token-abcdefghijklmnopqrstuvwxyz")\n  ```',
					'```scheme\n(f "partial\n``',
				]) {
					const colored = new Markdown(source, 0, 0, md).render(width);
					const baseline = new Markdown(source, 0, 0, plain).render(width);
					expect(colored.map(stripTerminalSequences)).toEqual(baseline.map(stripTerminalSequences));
					for (const line of colored) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
	});

	it("copies selected colored terminal cells without styling or split graphemes", async () => {
		const code = '(f "界🙂é")';
		const line = highlightCode(code, "scheme")[0];
		let copied = "";
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied = text;
				return true;
			},
		});
		tui.addChild(new Text(line, 0, 0));
		try {
			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput(`\x1b[<32;${visibleWidth(code)};1M`);
			terminal.sendInput(`\x1b[<3;${visibleWidth(code)};1m`);
			await terminal.waitForRender();
			expect(copied).toBe(code);
			expect(stripTerminalSequences(sliceByColumn(line, 4, 4, true))).toBe("界🙂");
		} finally {
			tui.stop();
		}
	});

	it("measures a realistic growing fence without a timing-sensitive assertion", () => {
		const source = sample.repeat(8);
		const md = getMarkdownTheme();
		const start = performance.now();
		let calls = 0;
		for (let end = 32; end < source.length; end += 32) {
			md.highlightCode?.(source.slice(0, end), "scheme");
			calls++;
		}
		const elapsed = performance.now() - start;
		expect(stripTerminalSequences(md.highlightCode?.(source, "scheme")?.join("\n") ?? "")).toBe(source);
		console.log(
			JSON.stringify({
				schemeStreaming: { chars: source.length, calls, elapsedMs: elapsed, meanMs: elapsed / calls },
			}),
		);
	});
});
