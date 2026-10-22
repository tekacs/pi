import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Extract and join text from message content. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** System prompt blocks, with exactly the separators used by the string renderer. */
export function systemBlocks(message: SystemMessage, update = false): TextContent[] {
	const blocks: TextContent[] =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.map((block, index) => ({ ...block, text: `${index === 0 ? "" : "\n"}${block.text}` }));
	if (blocks.every((block) => block.text.length === 0 && block.cache === undefined)) blocks.length = 0;
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		const text = update
			? value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`
			: value;
		if (text === null || (!update && text.length === 0)) continue;
		blocks.push({ type: "text", text: `${blocks.length > 0 ? "\n\n" : ""}${text}` });
	}
	return blocks;
}

/** Render a system message as a complete prompt: its content followed by its sections. */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 * This framing is request-time only and may change between versions.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}
