import type { Api, Model } from "../types.ts";

const MAX_SGR_PARAM_LENGTH = 48;
const MAX_RAW_ESC_PREFIX_SPACES = 8;
const BARE_SGR_FULL_PATTERN = /^(?:0|[12](?:;[0-9;:]+)?|[34]8;2;[0-9;]+)$/;
const BARE_SGR_PREFIX_PATTERN = /^(?:0|[12](?:;[0-9;:]*)?|[34](?:8(?:;(?:2(?:;[0-9;]*)?)?)?)?)$/;

type MatchResult =
	| { readonly status: "match"; readonly end: number; readonly params: string }
	| { readonly status: "incomplete" }
	| { readonly status: "none" };

export interface OutputAnsiNormalizerOptions {
	/**
	 * Heal bare SGR brackets such as `[1;38;2;...m` or `[0m` after whitespace,
	 * start of text, or `(`. Enable for Google/Gemini family models whose input
	 * preprocessor can strip ESC bytes from replayed prompts.
	 */
	healBareSgr?: boolean;
}

/** Whether a model belongs to the Google/Gemini family (direct or routed via OpenRouter/gateways). */
export function isGoogleFamilyModel(model: Pick<Model<Api>, "provider" | "api" | "id">): boolean {
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		return true;
	}
	const provider = model.provider.toLowerCase();
	if (provider === "google" || provider === "google-vertex") {
		return true;
	}
	const id = model.id.toLowerCase();
	return id.startsWith("google/") || id.includes("gemini") || id.includes("gemma");
}

function isSgrParamChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a;
}

function isBareSgrBoundary(ch: string): boolean {
	return ch === "" || ch === "(" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function matchLiteralPrefix(
	buf: string,
	start: number,
	target: string,
	caseInsensitiveLastHex: boolean,
	final: boolean,
): "match" | "incomplete" | "none" {
	for (let offset = 0; offset < target.length; offset++) {
		const idx = start + offset;
		if (idx >= buf.length) {
			return final ? "none" : "incomplete";
		}
		const actual = buf[idx]!;
		const expected = target[offset]!;
		if (actual === expected) continue;
		if (caseInsensitiveLastHex && expected === "b" && actual === "B") continue;
		return "none";
	}
	return "match";
}

function scanSgrParams(buf: string, paramStart: number, final: boolean): MatchResult {
	let k = paramStart;
	const limit = Math.min(buf.length, paramStart + MAX_SGR_PARAM_LENGTH + 1);
	while (k < limit) {
		const ch = buf[k]!;
		if (ch === "m") {
			return { status: "match", end: k + 1, params: buf.slice(paramStart, k) };
		}
		if (isSgrParamChar(ch)) {
			k++;
			continue;
		}
		return { status: "none" };
	}
	if (k >= buf.length) {
		return final ? { status: "none" } : { status: "incomplete" };
	}
	return { status: "none" };
}

/**
 * Match printable escaped SGR sequences in prose:
 * - `\e[...m`
 * - `\x1b[...m` / `\x1B[...m`
 * - `\u001b[...m` / `\u001B[...m`
 */
function matchEscapedSgr(buf: string, start: number, final: boolean): MatchResult {
	if (start + 1 >= buf.length) {
		return final ? { status: "none" } : { status: "incomplete" };
	}
	const second = buf[start + 1]!;
	let bracketOffset: number;
	if (second === "e") {
		const status = matchLiteralPrefix(buf, start, "\\e[", false, final);
		if (status !== "match") return { status };
		bracketOffset = 3;
	} else if (second === "x") {
		const status = matchLiteralPrefix(buf, start, "\\x1b[", true, final);
		if (status !== "match") return { status };
		bracketOffset = 5;
	} else if (second === "u") {
		const status = matchLiteralPrefix(buf, start, "\\u001b[", true, final);
		if (status !== "match") return { status };
		bracketOffset = 7;
	} else {
		return { status: "none" };
	}
	return scanSgrParams(buf, start + bracketOffset, final);
}

/**
 * Match raw ESC / SentencePiece `<0x1B>` / 8-bit CSI (`\u009b`) SGR sequences:
 * - `\u001b[...m`
 * - `\u001b [...m`, `\u001b\u001b[...m`, `\u001b<0x1B>[...m`
 * - `<0x1B>[...m`
 * - `\u009b...m`
 */
function matchRawOrTokenEscSgr(buf: string, start: number, final: boolean): MatchResult {
	const first = buf[start]!;
	if (first === "\u009b") {
		return scanSgrParams(buf, start + 1, final);
	}

	let k = start;
	if (first === "<") {
		const tokenStatus = matchLiteralPrefix(buf, k, "<0x1b>", true, final);
		if (tokenStatus !== "match") return { status: tokenStatus };
		k += 6;
	} else if (first === "\u001b") {
		k += 1;
	} else {
		return { status: "none" };
	}

	let spaces = 0;
	while (k < buf.length) {
		const ch = buf[k]!;
		if (ch === "\u001b") {
			k++;
			continue;
		}
		if (ch === " ") {
			if (spaces >= MAX_RAW_ESC_PREFIX_SPACES) {
				return { status: "none" };
			}
			spaces++;
			k++;
			continue;
		}
		if (ch === "<") {
			const tokenStatus = matchLiteralPrefix(buf, k, "<0x1b>", true, final);
			if (tokenStatus === "incomplete") return { status: "incomplete" };
			if (tokenStatus === "match") {
				k += 6;
				continue;
			}
			return { status: "none" };
		}
		break;
	}

	if (k >= buf.length) {
		return final ? { status: "none" } : { status: "incomplete" };
	}
	if (buf[k] !== "[") {
		return { status: "none" };
	}
	return scanSgrParams(buf, k + 1, final);
}

/**
 * Match bare SGR bracket remnants such as `[1;38;2;...m` or `[0m` after a
 * prose boundary (start of text, whitespace, or `(`).
 */
function matchBareSgr(buf: string, start: number, final: boolean): MatchResult {
	let k = start + 1;
	const limit = Math.min(buf.length, start + 1 + MAX_SGR_PARAM_LENGTH + 1);
	while (k < limit) {
		const ch = buf[k]!;
		if (ch === "m") {
			const params = buf.slice(start + 1, k);
			if (BARE_SGR_FULL_PATTERN.test(params)) {
				return { status: "match", end: k + 1, params };
			}
			return { status: "none" };
		}
		if (!isSgrParamChar(ch)) {
			return { status: "none" };
		}
		const prefix = buf.slice(start + 1, k + 1);
		if (!BARE_SGR_PREFIX_PATTERN.test(prefix)) {
			return { status: "none" };
		}
		k++;
	}
	if (k >= buf.length) {
		return final ? { status: "none" } : { status: "incomplete" };
	}
	return { status: "none" };
}

type NormalizerDirection = "to-terminal" | "to-printable";

/**
 * Stateful, buffered, Markdown code-fence and inline-backtick-aware SGR normalizer.
 *
 * Inside fenced code blocks (`` ``` `` / `~~~`) and inline code spans (`` `...` ``),
 * all text passes through verbatim without mutation. Outside code contexts:
 * - Translates printable `\e[...m` (as well as `\x1b[...m` / `\u001b[...m`) to real
 *   `\x1b[...m` sequences for terminal rendering.
 * - Heals malformed raw-ESC / `<0x1B>` / SentencePiece ESC+space sequences cleanly
 *   across chunk boundaries without ever doubling `<ESC><ESC>[`.
 * - Optionally heals bare SGR brackets (`[1;38;2;...m`, `[0m`) when `healBareSgr`
 *   is enabled for Google/Gemini family models.
 */
export class OutputAnsiNormalizer {
	private readonly healBareSgr: boolean;
	private readonly direction: NormalizerDirection;

	private mode: "prose" | "fence-opening" | "fenced" | "inline" = "prose";
	private atLineStart = true;
	private lineIndent = 0;
	private fenceChar: "`" | "~" | "" = "";
	private fenceLen = 0;
	private closeIndent = 0;
	private closeCount = 0;
	private closeTrailing = false;
	private inlineTicks = 0;
	private inlineSawNewline = false;
	private prevProseChar = "";
	private pending = "";

	constructor(options: OutputAnsiNormalizerOptions & { direction?: NormalizerDirection } = {}) {
		this.healBareSgr = options.healBareSgr ?? false;
		this.direction = options.direction ?? "to-terminal";
	}

	push(delta: string): string {
		if (delta.length === 0) return "";
		this.pending += delta;
		return this.drain(false);
	}

	flush(): string {
		if (this.pending.length === 0) return "";
		return this.drain(true);
	}

	/** Reset all parser and buffer state so a subsequent text block starts cleanly in prose mode. */
	reset(): void {
		this.mode = "prose";
		this.atLineStart = true;
		this.lineIndent = 0;
		this.fenceChar = "";
		this.fenceLen = 0;
		this.closeIndent = 0;
		this.closeCount = 0;
		this.closeTrailing = false;
		this.inlineTicks = 0;
		this.inlineSawNewline = false;
		this.prevProseChar = "";
		this.pending = "";
	}

	private emitPrefix(): string {
		return this.direction === "to-terminal" ? "\u001b[" : "\\e[";
	}

	private resetCloseTracker(): void {
		this.closeIndent = 0;
		this.closeCount = 0;
		this.closeTrailing = false;
	}

	private drain(final: boolean): string {
		const buf = this.pending;
		let i = 0;
		let out = "";

		while (i < buf.length) {
			const ch = buf[i]!;

			if (this.mode === "fenced") {
				out += ch;
				if (ch === "\n") {
					if (this.closeIndent >= 0 && this.closeCount >= this.fenceLen) {
						this.mode = "prose";
						this.atLineStart = true;
						this.lineIndent = 0;
						this.prevProseChar = "\n";
					}
					this.resetCloseTracker();
				} else if (ch !== "\r" && this.closeIndent >= 0) {
					if (this.closeCount === 0 && ch === " ") {
						if (this.closeIndent < 3) {
							this.closeIndent++;
						} else {
							this.closeIndent = -1;
						}
					} else if (!this.closeTrailing && ch === this.fenceChar) {
						this.closeCount++;
					} else if (this.closeCount >= this.fenceLen && (ch === " " || ch === "\t")) {
						this.closeTrailing = true;
					} else {
						this.closeIndent = -1;
					}
				}
				i++;
				continue;
			}

			if (this.mode === "fence-opening") {
				if (this.fenceChar === "~") {
					out += ch;
					if (ch === "\n") {
						this.mode = "fenced";
						this.resetCloseTracker();
					}
					i++;
					continue;
				}
				// Backtick fence opening: info string cannot contain backticks in CommonMark.
				if (ch === "\n") {
					out += ch;
					this.mode = "fenced";
					this.resetCloseTracker();
					i++;
					continue;
				}
				if (ch === "`") {
					let runEnd = i;
					while (runEnd < buf.length && buf[runEnd] === "`") {
						runEnd++;
					}
					if (runEnd === buf.length && !final) {
						break;
					}
					const runLen = runEnd - i;
					out += buf.slice(i, runEnd);
					i = runEnd;
					if (runLen === this.fenceLen) {
						this.mode = "prose";
						this.atLineStart = false;
						this.lineIndent = -1;
						this.prevProseChar = "`";
					} else {
						this.mode = "inline";
						this.inlineTicks = this.fenceLen;
						this.inlineSawNewline = false;
					}
					continue;
				}
				out += ch;
				i++;
				continue;
			}

			if (this.mode === "inline") {
				if (ch === "`") {
					let runEnd = i;
					while (runEnd < buf.length && buf[runEnd] === "`") {
						runEnd++;
					}
					if (runEnd === buf.length && !final) {
						break;
					}
					const runLen = runEnd - i;
					out += buf.slice(i, runEnd);
					i = runEnd;
					this.inlineSawNewline = false;
					if (runLen === this.inlineTicks) {
						this.mode = "prose";
						this.atLineStart = false;
						this.lineIndent = -1;
						this.prevProseChar = "`";
					}
					continue;
				}
				out += ch;
				i++;
				if (ch === "\n") {
					if (this.inlineSawNewline) {
						// Blank line recovers from an unclosed stray backtick in prose.
						this.mode = "prose";
						this.atLineStart = true;
						this.lineIndent = 0;
						this.inlineTicks = 0;
						this.inlineSawNewline = false;
						this.prevProseChar = "\n";
					} else {
						this.inlineSawNewline = true;
					}
				} else if (ch !== "\r" && ch !== " " && ch !== "\t") {
					this.inlineSawNewline = false;
				}
				continue;
			}

			// Prose mode: detect Markdown code spans and fenced code blocks first.
			if (ch === "`") {
				let runEnd = i;
				while (runEnd < buf.length && buf[runEnd] === "`") {
					runEnd++;
				}
				if (runEnd === buf.length && !final) {
					break;
				}
				const runLen = runEnd - i;
				out += buf.slice(i, runEnd);
				i = runEnd;
				if (this.atLineStart && this.lineIndent >= 0 && runLen >= 3) {
					this.mode = "fence-opening";
					this.fenceChar = "`";
					this.fenceLen = runLen;
				} else {
					this.mode = "inline";
					this.inlineTicks = runLen;
					this.inlineSawNewline = false;
				}
				this.atLineStart = false;
				this.lineIndent = -1;
				this.prevProseChar = "`";
				continue;
			}

			if (ch === "~" && this.atLineStart && this.lineIndent >= 0) {
				let runEnd = i;
				while (runEnd < buf.length && buf[runEnd] === "~") {
					runEnd++;
				}
				if (runEnd === buf.length && !final) {
					break;
				}
				const runLen = runEnd - i;
				out += buf.slice(i, runEnd);
				i = runEnd;
				if (runLen >= 3) {
					this.mode = "fence-opening";
					this.fenceChar = "~";
					this.fenceLen = runLen;
				}
				this.atLineStart = false;
				this.lineIndent = -1;
				this.prevProseChar = "~";
				continue;
			}

			// Prose mode: detect printable or raw/malformed SGR sequences.
			if (this.direction === "to-terminal" && ch === "\\") {
				const match = matchEscapedSgr(buf, i, final);
				if (match.status === "incomplete") break;
				if (match.status === "match") {
					out += `${this.emitPrefix()}${match.params}m`;
					i = match.end;
					this.atLineStart = false;
					this.lineIndent = -1;
					this.prevProseChar = "m";
					continue;
				}
			}

			if (ch === "\u001b" || ch === "\u009b" || ch === "<") {
				const match = matchRawOrTokenEscSgr(buf, i, final);
				if (match.status === "incomplete") break;
				if (match.status === "match") {
					out += `${this.emitPrefix()}${match.params}m`;
					i = match.end;
					this.atLineStart = false;
					this.lineIndent = -1;
					this.prevProseChar = "m";
					continue;
				}
			}

			if (
				this.direction === "to-terminal" &&
				ch === "[" &&
				this.healBareSgr &&
				isBareSgrBoundary(this.prevProseChar)
			) {
				const match = matchBareSgr(buf, i, final);
				if (match.status === "incomplete") break;
				if (match.status === "match") {
					out += `${this.emitPrefix()}${match.params}m`;
					i = match.end;
					this.atLineStart = false;
					this.lineIndent = -1;
					this.prevProseChar = "m";
					continue;
				}
			}

			out += ch;
			i++;
			this.prevProseChar = ch;
			if (ch === "\n") {
				this.atLineStart = true;
				this.lineIndent = 0;
			} else if (this.atLineStart && ch === " ") {
				if (this.lineIndent >= 0 && this.lineIndent < 3) {
					this.lineIndent++;
				} else {
					this.lineIndent = -1;
				}
			} else if (ch !== "\r") {
				this.atLineStart = false;
				this.lineIndent = -1;
			}
		}

		this.pending = buf.slice(i);
		return out;
	}
}

/** Normalize a complete text string from printable/malformed SGR to terminal `\x1b[...m`. */
export function normalizeOutputAnsi(text: string, options?: OutputAnsiNormalizerOptions): string {
	const normalizer = new OutputAnsiNormalizer(options);
	return normalizer.push(text) + normalizer.flush();
}

/**
 * Normalize assistant message SGR sequences back to printable `\e[...m` for
 * provider history replay so every model sees clean in-distribution tokens.
 * Code fences and inline code spans remain untouched.
 */
export function normalizeAssistantHistoryAnsi(text: string): string {
	if (!text.includes("\u001b") && !text.includes("\u009b") && !text.includes("<0x1b>") && !text.includes("<0x1B>")) {
		return text;
	}
	const normalizer = new OutputAnsiNormalizer({ direction: "to-printable" });
	return normalizer.push(text) + normalizer.flush();
}
