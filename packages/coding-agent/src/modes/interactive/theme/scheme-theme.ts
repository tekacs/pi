import { type Color, foregroundAnsi, mixColors } from "@earendil-works/pi-tui";
import type { HighlightFormatter } from "../../../utils/syntax-highlight.ts";
import type { Theme } from "./theme.ts";

/** Syntax roles follow the active palette; depth colors are softer than the heads they frame. */
export function buildSchemeTheme(theme: Theme): Record<string, HighlightFormatter> {
	const colors = theme.colors;
	const soften = (color: Color, amount: number): HighlightFormatter => {
		// Unknown terminal palette entries must stay indexed, not become guessed RGB colors.
		const fg = color.kind === "indexed" && color.index < 16 ? color : mixColors(color, colors.text, amount, "srgb");
		const ansi = foregroundAnsi(fg, theme.getColorMode());
		return (text) => `${ansi}${text}\x1b[39m`;
	};
	const result: Record<string, HighlightFormatter> = {
		"scheme.form": (text) => theme.style(text, { fg: "syntaxFunction", bold: true }),
		"scheme.call": (text) => theme.fg("syntaxVariable", text),
		"scheme.constructor": (text) => theme.style(text, { fg: "syntaxVariable", bold: true }),
		"scheme.binding": (text) => theme.fg("syntaxKeyword", text),
		"scheme.keyword": (text) => theme.fg("syntaxType", text),
		"scheme.qualified": (text) => theme.fg("syntaxNumber", text),
		"scheme.string": (text) => theme.fg("syntaxString", text),
		"scheme.number": (text) => theme.fg("syntaxType", text),
		"scheme.comment": (text) => theme.fg("syntaxComment", text),
		"scheme.data": soften(colors.syntaxString, 0.45),
		"scheme.punctuation": (text) => theme.fg("syntaxPunctuation", text),
	};
	const depth = [
		colors.syntaxFunction,
		colors.syntaxType,
		colors.syntaxVariable,
		colors.syntaxNumber,
		colors.syntaxString,
		colors.syntaxKeyword,
	];
	for (const [index, color] of depth.entries()) {
		// Blend toward foreground, not background: quiet brackets remain readable on both appearances.
		result[`scheme.depth${index}`] = soften(color, 0.28);
	}
	return result;
}
