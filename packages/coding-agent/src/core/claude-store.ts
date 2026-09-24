import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

interface Log {
	key: SessionKey;
	entries: SessionStoreEntry[];
	ids: Map<string, { entry: SessionStoreEntry; index: number }>;
}
/** Explicit owner shared only by the writers of one memory-only Pi session. */
export class ClaudeMemory {
	readonly logs = new Map<string, Log>();
	readonly bindings = new Map<string, unknown>();
	private controller = new AbortController();
	readonly signal: AbortSignal = this.controller.signal;

	close(): void {
		this.controller.abort();
		this.logs.clear();
		this.bindings.clear();
	}
}

/** One writer namespace per native process. Cold resumes stage a fresh namespace, never reopen a source for writing. */
export class ClaudeStore implements SessionStore {
	private root?: string;
	private memory: ClaudeMemory;
	private logs = new Map<string, Log>();
	private tail = Promise.resolve();
	private listeners = new Set<() => void>();
	private failure?: Error;
	private writer?: string;

	constructor(resource: string | ClaudeMemory = new ClaudeMemory()) {
		this.root = typeof resource === "string" ? resolve(resource) : undefined;
		this.memory = typeof resource === "string" ? new ClaudeMemory() : resource;
		if (!this.root) this.logs = this.memory.logs;
	}

	private available(): void {
		if (this.memory.signal.aborted) throw new Error("Native memory session is closed");
		if (this.failure) throw this.failure;
	}

	path(key: SessionKey): string | undefined {
		identity(key);
		return this.root
			? join(
					this.root,
					"sessions",
					hash([key.projectKey, key.sessionId]),
					`${key.subpath ? hash(key.subpath) : "main"}.jsonl`,
				)
			: undefined;
	}

	private read(key: SessionKey, supplied?: string): Log | undefined {
		this.available();
		const id = identity(key);
		const cached = this.logs.get(id);
		if (cached) return cached;
		const path = this.path(key);
		let log: Log | undefined;
		if (path) {
			if (!existsSync(path)) return undefined;
			const text = supplied ?? readFileSync(path, "utf8");
			if (!text.endsWith("\n")) throw new Error("Native transcript has an incomplete record");
			const lines = text.trimEnd().split("\n");
			const header = JSON.parse(lines.shift()!);
			if (identity(header.key) !== id) throw new Error("Native transcript key mismatch");
			log = { key: structuredClone(key), entries: lines.map((line) => JSON.parse(line)), ids: new Map() };
			for (const [index, entry] of log.entries.entries()) {
				if (typeof entry.type !== "string") throw new Error("Invalid native record");
				if (entry.uuid) {
					if (log.ids.has(entry.uuid)) throw new Error("Duplicate native record identity");
					log.ids.set(entry.uuid, { entry, index });
				}
			}
		} else log = this.memory.logs.get(id);
		if (log) this.logs.set(id, log);
		return log;
	}

	append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
		key = structuredClone(key);
		const batch: SessionStoreEntry[] = JSON.parse(JSON.stringify(entries));
		const operation = this.tail
			.then(() => {
				this.available();
				const namespace = JSON.stringify([key.projectKey, key.sessionId]);
				if (this.writer && this.writer !== namespace)
					throw new Error("Native writer cannot cross session namespaces");
				if (!this.writer) {
					const path = this.path(key);
					const exists = path
						? existsSync(dirname(path))
						: [...this.memory.logs.values()].some(
								(log) => log.key.projectKey === key.projectKey && log.key.sessionId === key.sessionId,
							);
					if (exists) throw new Error("Native source namespaces cannot be reopened for writing");
					this.writer = namespace;
				}
				const id = identity(key);
				const existing = this.read(key);
				const log: Log = existing ?? {
					key: structuredClone(key),
					entries: [],
					ids: new Map(),
				};
				const additions: SessionStoreEntry[] = [];
				const ids = new Map<string, SessionStoreEntry>();
				for (const snapshot of batch) {
					if (typeof snapshot.type !== "string") throw new Error("Invalid native record");
					const previous = snapshot.uuid
						? (ids.get(snapshot.uuid) ?? log.ids.get(snapshot.uuid)?.entry)
						: undefined;
					if (previous) {
						if (!isDeepStrictEqual(previous, snapshot))
							throw new Error(`Conflicting native record ${snapshot.uuid}`);
						continue;
					}
					additions.push(snapshot);
					if (snapshot.uuid) ids.set(snapshot.uuid, snapshot);
				}
				const path = this.path(key);
				if (path) {
					ensureDirectory(dirname(path));
					const fd = openSync(path, existing ? "a" : "wx", 0o600);
					try {
						if (!existing) writeFileSync(fd, `${JSON.stringify({ key })}\n`);
						for (const entry of additions) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
					if (!existing) syncDirectory(dirname(path));
				} else this.memory.logs.set(id, log);
				for (const entry of additions) {
					if (entry.uuid) log.ids.set(entry.uuid, { entry, index: log.entries.length });
					log.entries.push(entry);
				}
				this.logs.set(id, log);
				for (const listener of this.listeners) listener();
			})
			.catch((error: unknown) => this.fail(error));
		this.tail = operation.catch(() => {});
		return operation;
	}

	async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
		await this.tail;
		if (this.failure) throw this.failure;
		return structuredClone(this.read(key)?.entries ?? null);
	}

	async listSubkeys(key: SessionKey): Promise<string[]> {
		this.available();
		const path = this.path(key);
		if (path && existsSync(dirname(path))) {
			for (const file of readdirSync(dirname(path))) {
				if (!file.endsWith(".jsonl") || file === "main.jsonl") continue;
				const text = readFileSync(join(dirname(path), file), "utf8");
				const stored: SessionKey = JSON.parse(text.slice(0, text.indexOf("\n"))).key;
				if (this.path(stored) !== join(dirname(path), file))
					throw new Error("Native subkey does not match its storage path");
				this.read(stored, text);
			}
		}
		const logs = path ? this.logs.values() : this.memory.logs.values();
		return [...logs].flatMap(({ key: stored }) =>
			stored.projectKey === key.projectKey && stored.sessionId === key.sessionId && stored.subpath
				? [stored.subpath]
				: [],
		);
	}

	wait(sessionId: string, uuid: string, signal?: AbortSignal): Promise<SessionKey> {
		return new Promise((resolve, reject) => {
			const deadline = AbortSignal.timeout(65_000);
			const aborted = AbortSignal.any([this.memory.signal, deadline, ...(signal ? [signal] : [])]);
			const inspect = () => {
				const key = [...this.logs.values()].find(
					(log) => log.key.sessionId === sessionId && !log.key.subpath && log.ids.has(uuid),
				)?.key;
				if (!this.failure && !aborted.aborted && !key) return;
				this.listeners.delete(inspect);
				aborted.removeEventListener("abort", inspect);
				if (this.failure || aborted.aborted)
					reject(this.failure ?? new Error("Native mirror did not reach the observed boundary"));
				else resolve(structuredClone(key!));
			};
			this.listeners.add(inspect);
			aborted.addEventListener("abort", inspect, { once: true });
			inspect();
		});
	}

	position(key: SessionKey, cursor: string): number {
		const index = this.read(key)?.ids.get(cursor)?.index;
		if (index === undefined) throw new Error("Native checkpoint record is missing");
		return index;
	}

	/** Read an indexed interval of the durable mirror, excluding an optional previous cut. */
	prefix(key: SessionKey, cursor: string, after?: string): readonly SessionStoreEntry[] {
		if (this.failure) throw this.failure;
		const log = this.read(key);
		const end = log?.ids.get(cursor)?.index;
		const start = after === undefined ? -1 : log?.ids.get(after)?.index;
		if (!log || end === undefined || start === undefined || start > end)
			throw new Error("Native checkpoint interval is missing");
		return log.entries.slice(start + 1, end + 1);
	}

	/** Opaque append-prefix cut. The native SDK, not Pi, interprets conversation ancestry. */
	async cut(key: SessionKey, cursor: string, signal?: AbortSignal): Promise<SessionStoreEntry[]> {
		const path = this.path(key);
		if (!path) {
			const entries = await this.load(key);
			const index = entries?.findIndex((entry) => entry.uuid === cursor) ?? -1;
			if (!entries || index < 0) throw new Error("Native checkpoint record is missing");
			return entries.slice(0, index + 1);
		}
		// A source can keep appending after this immutable cut. Never parse or wait
		// for its future tail, which may be in the middle of a write.
		const entries: SessionStoreEntry[] = [];
		let header = true;
		let pending = "";
		for await (const chunk of createReadStream(path, { encoding: "utf8", signal })) {
			pending += chunk;
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline < 0) break;
				const value = JSON.parse(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				if (header) {
					if (identity(value.key) !== identity(key)) throw new Error("Native transcript key mismatch");
					header = false;
				} else {
					if (typeof value.type !== "string") throw new Error("Invalid native record");
					entries.push(value);
					if (value.uuid === cursor) return entries;
				}
			}
		}
		throw new Error("Native checkpoint record is missing");
	}

	/** Materialize an immutable source cut under the SDK's destination project key. */
	async fork(
		key: SessionKey,
		cursor: string,
		signal?: AbortSignal,
		imported: readonly SessionStoreEntry[] = [],
	): Promise<ReturnType<ClaudeStore["stage"]>> {
		if (this.writer) throw new Error("Native fork requires a fresh writer");
		if (key.subpath || (await this.listSubkeys(key)).length)
			throw new Error("Native child cuts are not implemented; exact continuation refused");
		const records = await this.cut(key, cursor, signal);
		return this.stage([...records, ...imported]);
	}

	/** Stage an existing native cut or a structured provider import with the same writer contract. */
	stage(entries: readonly SessionStoreEntry[]): {
		resume: string;
		resumeSessionAt: string;
		sessionStore: SessionStore;
	} {
		if (this.writer) throw new Error("Native fork requires a fresh writer");
		const records = structuredClone([...entries]);
		const cursor = records.at(-1)?.uuid;
		if (!cursor) throw new Error("Native staging requires a final record identity");
		const resume = randomUUID();
		let project: string | undefined;
		let staging: Promise<void> | undefined;
		const prepare = async (requested: SessionKey) => {
			if (requested.sessionId !== resume || requested.subpath)
				throw new Error("Native fork requested an unexpected resource");
			if (project !== undefined && project !== requested.projectKey)
				throw new Error("Native fork project changed during staging");
			project = requested.projectKey;
			staging ??= this.append(requested, records);
			await staging;
		};
		return {
			resume,
			resumeSessionAt: cursor,
			sessionStore: {
				append: (resource, entries) => this.append(resource, entries),
				load: async (resource) => {
					await prepare(resource);
					return this.load(resource);
				},
				listSubkeys: async (resource) => {
					await prepare(resource);
					return this.listSubkeys(resource);
				},
			},
		};
	}

	binding(id: string): unknown {
		this.available();
		if (!this.root) return structuredClone(this.memory.bindings.get(id));
		const path = join(this.root, "checkpoints", `${hash(id)}.json`);
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	}

	bind(id: string, value: unknown): void {
		try {
			this.publish(id, value);
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): never {
		this.failure = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.listeners) listener();
		throw this.failure;
	}

	private publish(id: string, value: unknown): void {
		this.available();
		value = JSON.parse(JSON.stringify(value));
		const previous = this.binding(id);
		if (previous !== undefined) {
			if (!isDeepStrictEqual(previous, value)) throw new Error("Conflicting native checkpoint binding");
			return;
		}
		if (!this.root) {
			this.memory.bindings.set(id, structuredClone(value));
			return;
		}
		const path = join(this.root, "checkpoints", `${hash(id)}.json`);
		ensureDirectory(dirname(path));
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify(value));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				linkSync(temporary, path);
			} catch (error) {
				if (!isDeepStrictEqual(this.binding(id), value)) throw error;
			}
			syncDirectory(dirname(path));
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}

function identity(key: SessionKey): string {
	if (!key.projectKey || !key.sessionId || key.subpath === "") throw new Error("Invalid native session key");
	return JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function ensureDirectory(path: string): void {
	const missing: string[] = [];
	for (let cursor = path; !existsSync(cursor); cursor = dirname(cursor)) missing.push(cursor);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	for (const directory of missing.reverse()) syncDirectory(dirname(directory));
}
function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
