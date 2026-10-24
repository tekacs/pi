import { isSchemeNumber, type SchemeToken, schemeTokens } from "./scheme-reader.ts";
import type { HighlightTheme } from "./syntax-highlight.ts";

export type SchemeRole =
	| "plain"
	| "comment"
	| "string"
	| "number"
	| "data"
	| "form"
	| "call"
	| "binding"
	| "keyword"
	| "qualified"
	| "constructor"
	| "punctuation";
export interface SchemeSpan {
	start: number;
	end: number;
	role: SchemeRole;
	depth?: number;
}

type Mode = "code" | "formals" | "bindings" | "binding" | "signature";
interface Context {
	literal: boolean;
	quasi: number;
	comment: boolean;
	mode: Mode;
}
interface Frame extends Context {
	kind: "root" | "list" | "prefix" | "discard";
	index: number;
	head?: string;
	named?: boolean;
	close?: string;
	depth: number;
}
const CORE = new Set(
	"define define-values define-syntax define-syntax-rule lambda λ case-lambda let let* letrec letrec* let-values let*-values if cond case and or begin begin0 set! do delay quote quasiquote unquote unquote-splicing syntax-rules syntax-case match when unless import export require provide".split(
		" ",
	),
);
const LET = new Set(["let", "let*", "letrec", "letrec*"]);
const DEFINE = new Set(["define", "define-syntax", "define-syntax-rule", "define-values"]);

export function isSchemeLanguage(language?: string): boolean {
	return language !== undefined && /^(scheme|scm|ss|steel)$/i.test(language.trim());
}

function datumContext(parent: Frame): Context {
	const context: Context = { literal: parent.literal, quasi: parent.quasi, comment: parent.comment, mode: "code" };
	if (parent.kind !== "list") return { ...context, mode: parent.mode };
	if (parent.index === 1 && !parent.literal) {
		if (parent.head === "quote") context.literal = true;
		if (parent.head === "quasiquote") context.quasi++;
		if (parent.head === "unquote" || parent.head === "unquote-splicing")
			context.quasi = Math.max(0, context.quasi - 1);
	}
	if (context.literal || context.quasi > 0) return context;
	if (parent.mode === "formals" || parent.mode === "signature") context.mode = "formals";
	else if (parent.mode === "bindings") context.mode = "binding";
	else if (parent.mode === "code") {
		if (parent.index === 1 && DEFINE.has(parent.head ?? ""))
			context.mode = parent.head === "define-values" ? "formals" : "signature";
		if (parent.index === 1 && (parent.head === "lambda" || parent.head === "λ")) context.mode = "formals";
		if (LET.has(parent.head ?? "") && (parent.index === 1 || (parent.index === 2 && parent.named)))
			context.mode = "bindings";
	}
	return context;
}

function atomRole(atom: string, token: SchemeToken, parent: Frame, context: Context): SchemeRole {
	if (context.comment) return "comment";
	if (token.kind === "string" || atom.startsWith("#\\")) return "string";
	if (!token.escaped && (isSchemeNumber(atom) || /^#(?:t|f|true|false)$/i.test(atom))) return "number";
	if (context.literal || context.quasi > 0) return "data";
	if (!token.escaped && atom.startsWith("#:")) return "keyword";
	if (atom === ".") return "punctuation";
	if (context.mode === "signature" || context.mode === "formals" || (parent.mode === "binding" && parent.index === 0))
		return "binding";
	if (LET.has(parent.head ?? "") && parent.index === 1 && parent.mode === "code") return "binding";
	if (!token.escaped && /^[^:]+(?:::[^:]+)+$/.test(atom)) return "qualified";
	if (parent.kind === "list" && parent.mode === "code" && parent.index === 0) {
		if (/^[a-z]!$/i.test(atom)) return "constructor";
		return CORE.has(atom) || parent.depth === 0 ? "form" : "call";
	}
	return "plain";
}

/** Read syntax, not program meaning. Unknown macros do not introduce guessed bindings. */
export function schemeSpans(source: string): SchemeSpan[] {
	const spans: SchemeSpan[] = [];
	const stack: Frame[] = [
		{ kind: "root", index: 0, depth: -1, literal: false, quasi: 0, comment: false, mode: "code" },
	];
	let depth = 0;
	const emit = (token: SchemeToken, role: SchemeRole, level?: number) => {
		const previous = spans[spans.length - 1];
		if (previous && previous.end === token.start && previous.role === role && previous.depth === level)
			previous.end = token.end;
		else spans.push({ start: token.start, end: token.end, role, depth: level });
	};
	const complete = () => {
		while (stack.length > 1 && stack[stack.length - 1].kind === "prefix") stack.pop();
		if (stack[stack.length - 1].kind === "discard") {
			stack.pop();
			return; // A datum comment is trivia, not a datum for an enclosing datum comment.
		}
		stack[stack.length - 1].index++;
	};
	for (const token of schemeTokens(source)) {
		const parent = stack[stack.length - 1];
		const atom = source.slice(token.start, token.end);
		if (token.kind === "space" || token.kind === "comment") {
			emit(token, parent.comment || token.kind === "comment" ? "comment" : "plain");
			continue;
		}
		const context = datumContext(parent);
		if (token.kind === "discard") {
			emit(token, "comment");
			stack.push({ ...context, comment: true, kind: "discard", depth, index: 0 });
		} else if (token.kind === "prefix") {
			emit(token, context.comment ? "comment" : "punctuation");
			if (atom.endsWith("'")) context.literal = true;
			else if (atom.endsWith("`")) context.quasi++;
			else if (!context.literal) context.quasi = Math.max(0, context.quasi - 1);
			stack.push({ ...context, kind: "prefix", depth, index: 0 });
		} else if (token.kind === "open") {
			const vector = atom.startsWith("#");
			if (vector && context.quasi === 0) context.literal = true;
			emit(token, context.comment ? "comment" : "punctuation", context.comment ? undefined : depth);
			stack.push({
				...context,
				kind: "list",
				close: atom.endsWith("[") ? "]" : atom.endsWith("{") ? "}" : ")",
				depth: depth++,
				index: 0,
			});
		} else if (token.kind === "close") {
			if (parent.kind === "list" && parent.close === atom) {
				emit(token, parent.comment ? "comment" : "punctuation", parent.comment ? undefined : parent.depth);
				stack.pop();
				depth--;
				complete();
			} else emit(token, parent.comment ? "comment" : "punctuation");
		} else {
			emit(token, atomRole(atom, token, parent, context));
			if (parent.kind === "list" && parent.index === 0 && !token.escaped && token.kind === "atom")
				parent.head = atom;
			if (parent.mode === "code" && parent.index === 1 && LET.has(parent.head ?? "")) parent.named = true;
			complete();
		}
	}
	return spans;
}

/** Per-consumer cache: source-only spans survive resize/theme changes. No global transcript retention. */
export class SchemeHighlighter {
	private source?: string;
	private spans?: SchemeSpan[];

	highlight(source: string, theme: HighlightTheme = {}): string {
		const spans = source === this.source && this.spans ? this.spans : schemeSpans(source);
		// Retain at most one modest block, never a large file or an entire transcript.
		if (source.length <= 256 * 1024) {
			this.source = source;
			this.spans = spans;
		} else {
			this.source = undefined;
			this.spans = undefined;
		}
		const output: string[] = [];
		for (const span of spans) {
			const text = source.slice(span.start, span.end);
			const formatter = theme[span.depth === undefined ? `scheme.${span.role}` : `scheme.depth${span.depth % 6}`];
			output.push(
				formatter
					? text
							.split("\n")
							.map((line) => (line ? formatter(line) : line))
							.join("\n")
					: text,
			);
		}
		return output.join("");
	}
}
