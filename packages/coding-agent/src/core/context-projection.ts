import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CACHE_CHECKPOINT, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { type CustomMessage, createCustomMessage } from "./messages.ts";
import type { CustomEntry, SessionEntry } from "./session-manager.ts";

/** Reserved custom entry type for append-only context/display range projections. */
export const PROJECTION_TYPE = "pi.context-projection";

export interface ProjectionCustomMessage<T = unknown> {
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
}

/** A provider-visible message emitted by a context projection. */
export type ProjectionMessage = AgentMessage | CustomMessage;

/** Ordered replacement messages inserted at the first projected source position. */
export interface ProjectionReplacement {
	messages: ProjectionMessage[];
}

/**
 * One legacy append-only projection directive.
 * A replacement of null clears the latest projection with the same key.
 */
export interface ContextProjection<T = unknown> {
	key: string;
	sourceEntryIds: string[];
	anchorEntryId?: string;
	replacement: ProjectionReplacement | ProjectionCustomMessage<T> | null;
}

/**
 * One complete, atomic projection state owned by `key`.
 * A later frame with the same key replaces the earlier frame as a whole.
 */
export interface ContextProjectionFrame<T = unknown> {
	version: 2;
	key: string;
	generation: number;
	fingerprint: string;
	directives: ContextProjection<T>[];
}

export type ContextProjectionData<T = unknown> = ContextProjection<T> | ContextProjectionFrame<T>;

export function isProjectionEntry(entry: SessionEntry): entry is CustomEntry<ContextProjectionData> {
	return entry.type === "custom" && entry.customType === PROJECTION_TYPE;
}

interface ResolvedDirective {
	key: string;
	sourceEntryIds: string[];
	anchorEntryId?: string;
	replacement: ProjectionMessage[] | null;
}

interface ResolvedFrame {
	key: string;
	generation: number | undefined;
	fingerprint: string | undefined;
	directives: ResolvedDirective[];
}

interface ProjectionVersion {
	entry: CustomEntry<ContextProjectionData>;
	data: ResolvedFrame;
	index: number;
}

function projectionMessage(value: unknown): ProjectionMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.role !== "string" || typeof message.timestamp !== "number") return undefined;
	if (message.role === "custom") {
		return typeof message.customType === "string" &&
			message.customType.length > 0 &&
			(typeof message.content === "string" || Array.isArray(message.content)) &&
			typeof message.display === "boolean"
			? (value as CustomMessage)
			: undefined;
	}
	if (message.role === "user") {
		return typeof message.content === "string" || Array.isArray(message.content)
			? (value as ProjectionMessage)
			: undefined;
	}
	if (message.role === "assistant") {
		return Array.isArray(message.content) ? (value as ProjectionMessage) : undefined;
	}
	if (message.role === "toolResult") {
		return typeof message.toolCallId === "string" &&
			typeof message.toolName === "string" &&
			Array.isArray(message.content)
			? (value as ProjectionMessage)
			: undefined;
	}
	return undefined;
}

function readDirective(value: unknown, timestamp: string): ResolvedDirective | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = value as Partial<ContextProjection>;
	if (typeof data.key !== "string" || data.key.length === 0) return undefined;
	if (
		!Array.isArray(data.sourceEntryIds) ||
		data.sourceEntryIds.some((id) => typeof id !== "string" || id.length === 0) ||
		new Set(data.sourceEntryIds).size !== data.sourceEntryIds.length
	) {
		return undefined;
	}
	if (
		data.anchorEntryId !== undefined &&
		(typeof data.anchorEntryId !== "string" || data.anchorEntryId.length === 0)
	) {
		return undefined;
	}
	if (data.replacement === null) {
		return {
			key: data.key,
			sourceEntryIds: data.sourceEntryIds,
			anchorEntryId: data.anchorEntryId,
			replacement: null,
		};
	}
	if (typeof data.replacement !== "object" || data.replacement === null) return undefined;

	const replacement = data.replacement as Partial<ProjectionReplacement & ProjectionCustomMessage>;
	if (Array.isArray(replacement.messages)) {
		const messages = replacement.messages.map(projectionMessage);
		return messages.every((message): message is ProjectionMessage => message !== undefined)
			? {
					key: data.key,
					sourceEntryIds: data.sourceEntryIds,
					anchorEntryId: data.anchorEntryId,
					replacement: messages,
				}
			: undefined;
	}

	if (
		typeof replacement.customType !== "string" ||
		replacement.customType.length === 0 ||
		(typeof replacement.content !== "string" && !Array.isArray(replacement.content)) ||
		typeof replacement.display !== "boolean"
	) {
		return undefined;
	}
	return {
		key: data.key,
		sourceEntryIds: data.sourceEntryIds,
		anchorEntryId: data.anchorEntryId,
		replacement: [
			createCustomMessage(
				replacement.customType,
				replacement.content,
				replacement.display,
				replacement.details,
				timestamp,
			),
		],
	};
}

function readFrame(entry: SessionEntry): ResolvedFrame | undefined {
	if (!isProjectionEntry(entry) || typeof entry.data !== "object" || entry.data === null) return undefined;
	const data = entry.data as Partial<ContextProjectionData>;

	if ("version" in data) {
		const frame = data as Partial<ContextProjectionFrame>;
		if (
			frame.version !== 2 ||
			typeof frame.key !== "string" ||
			frame.key.length === 0 ||
			!Number.isSafeInteger(frame.generation) ||
			(frame.generation ?? -1) < 0 ||
			typeof frame.fingerprint !== "string" ||
			frame.fingerprint.length === 0 ||
			!Array.isArray(frame.directives)
		) {
			return undefined;
		}
		const directives = frame.directives.map((directive) => readDirective(directive, entry.timestamp));
		if (directives.some((directive) => directive === undefined)) return undefined;
		const resolved = directives as ResolvedDirective[];
		if (new Set(resolved.map((directive) => directive.key)).size !== resolved.length) return undefined;

		const claimed = new Set<string>();
		for (const directive of resolved) {
			if (!directive.replacement) continue;
			for (const sourceId of directive.sourceEntryIds) {
				if (claimed.has(sourceId)) return undefined;
				claimed.add(sourceId);
			}
		}
		return {
			key: frame.key,
			generation: frame.generation,
			fingerprint: frame.fingerprint,
			directives: resolved,
		};
	}

	const directive = readDirective(data, entry.timestamp);
	return directive
		? { key: directive.key, generation: undefined, fingerprint: undefined, directives: [directive] }
		: undefined;
}

function replacementEntry(
	projection: CustomEntry<ContextProjectionData>,
	directiveIndex: number,
	message: ProjectionMessage,
	index: number,
	count: number,
): SessionEntry {
	const baseId = directiveIndex === 0 ? projection.id : `${projection.id}:d${directiveIndex}`;
	const id = count === 1 || index === 0 ? baseId : `${baseId}:${index}`;
	const parentId = index === 0 ? projection.parentId : index === 1 ? baseId : `${baseId}:${index - 1}`;
	const timestamp = new Date(message.timestamp).toISOString();
	if (message.role === "custom") {
		return {
			type: "custom_message",
			id,
			parentId,
			timestamp,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		};
	}
	return { type: "message", id, parentId, timestamp, message };
}

function signature(frame: ResolvedFrame): string {
	return frame.fingerprint ?? JSON.stringify(frame.directives);
}

function changedBoundary(
	history: ReadonlyMap<string, readonly ProjectionVersion[]>,
	acceptedKeys: ReadonlySet<string>,
	positions: ReadonlyMap<string, number>,
): number | undefined {
	let boundary: number | undefined;
	for (const key of acceptedKeys) {
		const versions = history.get(key) ?? [];
		const latest = versions.at(-1);
		if (!latest) continue;
		const previous = versions.at(-2);
		if (previous && signature(previous.data) === signature(latest.data)) continue;
		const touched = [latest, ...(previous ? [previous] : [])]
			.flatMap((version) => version.data.directives)
			.flatMap((directive) => [directive.anchorEntryId, ...directive.sourceEntryIds])
			.filter((id): id is string => id !== undefined)
			.map((id) => positions.get(id))
			.filter((position): position is number => position !== undefined);
		if (touched.length === 0) continue;
		const earliest = Math.min(...touched);
		boundary = boundary === undefined ? earliest : Math.min(boundary, earliest);
	}
	return boundary;
}

function carriesContext(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		(entry.type === "branch_summary" && entry.summary.length > 0) ||
		entry.type === "compaction"
	);
}

/** Apply the latest valid projection frames without exposing partial frame state. */
export function applyContextProjections(entries: SessionEntry[]): SessionEntry[] {
	const history = new Map<string, ProjectionVersion[]>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const data = readFrame(entry);
		if (!data || !isProjectionEntry(entry)) continue;
		const versions = history.get(data.key) ?? [];
		versions.push({ entry, data, index });
		history.set(data.key, versions);
	}
	if (history.size === 0) return entries;
	const latest = new Map([...history].map(([key, versions]) => [key, versions.at(-1)!]));

	const positions = new Map(entries.map((entry, index) => [entry.id, index]));
	const claimed = new Set<string>();
	const acceptedKeys = new Set<string>();
	const accepted: Array<{
		entry: CustomEntry<ContextProjectionData>;
		directiveIndex: number;
		messages: ProjectionMessage[];
		first: number;
	}> = [];

	for (const frame of [...latest.values()].sort((left, right) => right.index - left.index)) {
		const versions = history.get(frame.data.key) ?? [];
		const previous = versions.at(-2);
		const changed = !previous || signature(previous.data) !== signature(frame.data);
		const previousEffective =
			previous?.data.directives.some(
				(directive) =>
					directive.replacement !== null &&
					(directive.sourceEntryIds.some((id) => positions.has(id)) ||
						(directive.anchorEntryId !== undefined && positions.has(directive.anchorEntryId))),
			) ?? false;
		const foundByDirective = frame.data.directives.map((directive, directiveIndex) => ({
			directive,
			directiveIndex,
			found: directive.replacement ? directive.sourceEntryIds.filter((id) => positions.has(id)) : [],
		}));
		const found = foundByDirective.flatMap((directive) => directive.found);
		if (found.some((id) => claimed.has(id))) {
			if (changed && previousEffective) acceptedKeys.add(frame.data.key);
			continue;
		}
		const effective = foundByDirective.some(
			({ directive, found: directiveSources }) =>
				directive.replacement !== null &&
				(directiveSources.length > 0 ||
					(directive.anchorEntryId !== undefined && positions.has(directive.anchorEntryId))),
		);
		if (!effective) {
			if (changed && previousEffective) acceptedKeys.add(frame.data.key);
			continue;
		}

		acceptedKeys.add(frame.data.key);
		for (const id of found) claimed.add(id);
		for (const { directive, directiveIndex, found: directiveSources } of foundByDirective) {
			if (!directive.replacement) continue;
			const anchor = directive.anchorEntryId ? positions.get(directive.anchorEntryId) : undefined;
			if (directiveSources.length === 0 && anchor === undefined) continue;
			accepted.push({
				entry: frame.entry,
				directiveIndex,
				messages: directive.replacement,
				first: anchor ?? Math.min(...directiveSources.map((id) => positions.get(id)!)),
			});
		}
	}

	const replacements = new Map<number, SessionEntry[]>();
	accepted.sort(
		(left, right) =>
			left.first - right.first ||
			(positions.get(left.entry.id) ?? 0) - (positions.get(right.entry.id) ?? 0) ||
			left.directiveIndex - right.directiveIndex,
	);
	for (const projection of accepted) {
		const entriesAtAnchor = replacements.get(projection.first) ?? [];
		entriesAtAnchor.push(
			...projection.messages.map((message, index) =>
				replacementEntry(projection.entry, projection.directiveIndex, message, index, projection.messages.length),
			),
		);
		replacements.set(projection.first, entriesAtAnchor);
	}

	const boundary = changedBoundary(history, acceptedKeys, positions);
	const projected: SessionEntry[] = [];
	let checkpoint: SessionEntry | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const replacement = replacements.get(index);
		if (replacement) {
			projected.push(...replacement);
			if (boundary !== undefined && index < boundary) {
				for (const candidate of replacement) {
					if (carriesContext(candidate)) checkpoint = candidate;
				}
			}
		}
		if (isProjectionEntry(entry) || claimed.has(entry.id)) continue;
		projected.push(entry);
		if (boundary !== undefined && index < boundary && carriesContext(entry)) checkpoint = entry;
	}
	return checkpoint
		? projected.map((entry) => (entry === checkpoint ? { ...entry, [CACHE_CHECKPOINT]: true as const } : entry))
		: projected;
}
