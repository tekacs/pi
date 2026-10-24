export type SchemeKind = "space" | "comment" | "discard" | "prefix" | "open" | "close" | "string" | "atom";

export interface SchemeToken {
	start: number;
	end: number;
	kind: SchemeKind;
	/** Escaped symbols and character literals are not reader syntax. */
	escaped?: boolean;
}

const SPACE = /\s/y;
const VECTOR = /#(?:u8|vu8)?\(/iy;
const BOUNDARY = /[\s()[\]{}";'`,]/;

/** Lex available source without requiring a complete datum, preserving every UTF-16 offset. */
export function* schemeTokens(source: string): Generator<SchemeToken> {
	let index = 0;
	while (index < source.length) {
		const start = index;
		const char = source[index];
		let kind: SchemeKind = "atom";
		let escaped = false;
		SPACE.lastIndex = index;
		VECTOR.lastIndex = index;
		if (SPACE.test(source)) {
			kind = "space";
			while (index < source.length && /\s/.test(source[index])) index++;
		} else if (char === ";" || (index === 0 && source.startsWith("#!/", index))) {
			kind = "comment";
			const end = source.indexOf("\n", index);
			index = end < 0 ? source.length : end;
		} else if (source.startsWith("#!", index)) {
			kind = "comment";
			index += 2;
			while (index < source.length && !BOUNDARY.test(source[index])) index++;
		} else if (source.startsWith("#|", index)) {
			kind = "comment";
			let depth = 1;
			index += 2;
			while (index < source.length && depth > 0) {
				if (source.startsWith("#|", index)) {
					depth++;
					index += 2;
				} else if (source.startsWith("|#", index)) {
					depth--;
					index += 2;
				} else index++;
			}
		} else if (source.startsWith("#;", index)) {
			kind = "discard";
			index += 2;
		} else if (source.startsWith("#\\", index)) {
			escaped = true;
			index += 2;
			if (index < source.length) {
				const first = source[index];
				index += (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
				if (!BOUNDARY.test(first)) {
					while (index < source.length && !BOUNDARY.test(source[index])) index++;
				}
			}
		} else if (char === '"') {
			kind = "string";
			index++;
			while (index < source.length) {
				if (source[index] === "\\") index = Math.min(source.length, index + 2);
				else if (source[index++] === '"') break;
			}
		} else if (VECTOR.test(source)) {
			kind = "open";
			index = VECTOR.lastIndex;
		} else if ("([{".includes(char)) {
			kind = "open";
			index++;
		} else if (")]}".includes(char)) {
			kind = "close";
			index++;
		} else if ("'`,".includes(char) || (char === "#" && "'`,".includes(source[index + 1] ?? " "))) {
			kind = "prefix";
			if (char === "#") index++;
			if (source[index++] === "," && source[index] === "@") index++;
		} else {
			while (index < source.length && !BOUNDARY.test(source[index])) {
				if (source.startsWith("#|", index) || source.startsWith("#;", index)) break;
				if (source[index] === "\\") {
					escaped = true;
					index = Math.min(source.length, index + 2);
				} else if (source[index] === "|") {
					escaped = true;
					index++;
					while (index < source.length) {
						if (source[index] === "\\") index = Math.min(source.length, index + 2);
						else if (source[index++] === "|") break;
					}
				} else index++;
			}
		}
		yield { start, end: index, kind, escaped };
	}
}

/** Common Scheme real/complex literals; never color a numeric prefix of an identifier. */
export function isSchemeNumber(atom: string): boolean {
	const prefixes = atom.match(/^(?:#[eibodx]){1,2}/i)?.[0] ?? "";
	const value = atom.slice(prefixes.length);
	if (/#x/i.test(prefixes)) return /^[+-]?[\da-f]+(?:\/[\da-f]+)?$/i.test(value);
	if (/#b/i.test(prefixes)) return /^[+-]?[01]+(?:\/[01]+)?$/.test(value);
	if (/#o/i.test(prefixes)) return /^[+-]?[0-7]+(?:\/[0-7]+)?$/.test(value);
	if (value === "+i" || value === "-i") return true;
	return /^[+-]?(?:(?:\d+(?:\/\d+|\.\d*)?|\.\d+)(?:[esfdl][+-]?\d+)?(?:[+-](?:\d+(?:\.\d*)?|\.\d+)i|@[-+]?\d+(?:\.\d*)?)?|(?:inf|nan)\.0)$/i.test(
		value,
	);
}
