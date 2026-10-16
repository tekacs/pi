import { isDeepStrictEqual } from "node:util";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CustomMessage } from "./messages.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export type AdmittedMessage = Pick<CustomMessage, "customType" | "content" | "display" | "details">;
export interface AdmissionOptions {
	toolCallId?: string;
	policy?: string;
}
export interface InputRequest {
	id: string;
	entry: string;
	message: AdmittedMessage;
}
export type InputDecision = "allow" | "hold" | "cancel";
export interface InputPolicy {
	check(input: InputRequest): InputDecision | Promise<InputDecision>;
	accept?(input: InputRequest): void;
}

interface AdmissionRecord {
	version: 1;
	owner: string;
	id: string;
	action: "admit";
	message: AdmittedMessage;
	toolCallId?: string;
	policy?: string;
}
interface CancellationRecord {
	version: 1;
	owner: string;
	id: string;
	action: "cancel";
}
type InputRecord = AdmissionRecord | CancellationRecord;
interface Request {
	entry: string;
	record: AdmissionRecord;
}

export interface AdmissionPort {
	queue(message: CustomMessage): void;
	queued(request: string): boolean;
	executing(callId: string): boolean;
	discard(request: string): void;
	start(): Promise<void>;
	idle(): boolean;
	warn(error: unknown): void;
	policy?(name: string): InputPolicy | undefined;
}

const INPUT_TYPE = "pi-input";

/** The journal owns custody; queue membership is only the current execution of that custody. */
export class Admissions {
	private canonical = new Map<string, { message: AdmittedMessage; policy?: string }>();
	private permitted = new Set<string>();
	private epoch = 0;
	private requests = new Map<string, Request>();
	private pending = new Map<string, Request>();
	private issued = new Set<string>();
	private manager: SessionManager;
	private port: AdmissionPort;
	private cancelled = new Set<string>();
	private ready = false;
	private paused = false;
	private timer?: ReturnType<typeof setTimeout>;
	private delay = 100;
	private branchLeaf: string | null = null;
	private visible = new Map<string, string>();

	constructor(manager: SessionManager, port: AdmissionPort) {
		this.manager = manager;
		this.port = port;
		for (const entry of manager.getEntries()) {
			if (entry.type === "custom" && entry.customType === INPUT_TYPE) {
				const record = entry.data as InputRecord;
				if (record?.version !== 1 || typeof record.owner !== "string" || typeof record.id !== "string") {
					throw new Error("Invalid input admission record");
				}
				if (record.owner !== manager.getSessionId()) continue;
				if (record.action === "cancel") {
					this.cancelled.add(record.id);
					this.pending.delete(record.id);
				} else if (record.action === "admit" && record.message && typeof record.message.customType === "string") {
					this.remember({ entry: entry.id, record });
				} else throw new Error("Invalid input admission action");
			} else this.accept(entry);
		}
	}

	private remember(request: Request): void {
		const { id, message, policy } = request.record;
		const prior = this.canonical.get(id);
		if (prior && (!isDeepStrictEqual(prior.message, message) || prior.policy !== policy))
			throw new Error(`Input receipt ${id} changed content or policy`);
		if (this.cancelled.has(id)) throw new Error(`Input receipt ${id} was cancelled`);
		this.canonical.set(id, { message, policy });
		this.requests.set(request.entry, request);
		this.pending.set(id, request);
	}

	/** Synchronous return is persisted, synced custody, not a provider-read acknowledgement. */
	admit(id: string, message: AdmittedMessage, options: AdmissionOptions = {}): string {
		if (!id) throw new Error("Input receipt ID must not be empty");
		if (options.policy !== undefined && (typeof options.policy !== "string" || !options.policy.trim()))
			throw new Error("Input policy must be a nonempty name");
		if (!this.manager.isPersisted()) throw new Error("Input admission requires a persisted session");
		if (this.cancelled.has(id)) throw new Error(`Input receipt ${id} was cancelled`);
		// Only JSON data crosses the persistence boundary; detach caller-owned objects.
		const normalized = JSON.parse(JSON.stringify(message)) as AdmittedMessage;
		const prior = this.canonical.get(id);
		if (prior && (!isDeepStrictEqual(prior.message, normalized) || prior.policy !== options.policy))
			throw new Error(`Input receipt ${id} changed content or policy`);
		const pending = this.pending.get(id);
		if (pending) return pending.entry;
		this.updateBranch();
		const visible = this.visible.get(id);
		if (visible) return visible;
		const record: AdmissionRecord = {
			version: 1,
			owner: this.manager.getSessionId(),
			action: "admit",
			id,
			message: prior?.message ?? normalized,
			...(options.policy ? { policy: options.policy } : {}),
			...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
		};
		const entry = this.manager.appendCustomEntry(INPUT_TYPE, record, { durable: true });
		this.remember({ entry, record });
		this.paused = false; // A genuinely new admission, unlike a duplicate, can request inference.
		this.enqueue();
		this.refresh();
		return entry;
	}

	cancel(id: string): void {
		if (this.cancelled.has(id)) return;
		if (!this.manager.isPersisted()) throw new Error("Input cancellation requires a persisted session");
		const record: CancellationRecord = { version: 1, owner: this.manager.getSessionId(), action: "cancel", id };
		this.manager.appendCustomEntry(INPUT_TYPE, record, { durable: true });
		const pending = this.pending.get(id);
		if (pending) {
			this.port.discard(pending.entry);
			this.issued.delete(pending.entry);
		}
		this.pending.delete(id);
		if (pending) this.permitted.delete(pending.entry);
		this.cancelled.add(id);
	}

	/** Call only after the corresponding transcript append succeeds. */
	accept(entry: SessionEntry): void {
		if (entry.type === "custom_message" && entry.inputId) {
			const request = this.requests.get(entry.inputId);
			if (request && this.pending.get(request.record.id)?.entry === entry.inputId) {
				this.pending.delete(request.record.id);
				this.hold(entry.inputId);
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			for (const request of this.projections(entry.message)) {
				if (this.pending.get(request.record.id)?.entry !== request.entry) continue;
				this.pending.delete(request.record.id);
				this.hold(request.entry);
			}
		}
	}

	allowed(request: string): boolean {
		const admission = this.requests.get(request);
		return (
			!!admission &&
			!this.cancelled.has(admission.record.id) &&
			this.pending.get(admission.record.id)?.entry === request
		);
	}

	idle(): void {
		this.refresh();
	}

	private input(request: Request): InputRequest {
		return { id: request.record.id, entry: request.entry, message: structuredClone(request.record.message) };
	}

	async authorize(entry: string): Promise<boolean> {
		const request = this.requests.get(entry);
		if (!request || !this.allowed(entry)) return false;
		const epoch = this.epoch;
		const policy = request.record.policy ? this.port.policy?.(request.record.policy) : undefined;
		let decision: InputDecision;
		try {
			decision = request.record.policy ? ((await policy?.check(this.input(request))) ?? "hold") : "allow";
		} catch (error) {
			this.hold(entry);
			throw error;
		}
		if (
			!this.ready ||
			epoch !== this.epoch ||
			!this.allowed(entry) ||
			(request.record.policy && this.port.policy?.(request.record.policy) !== policy)
		) {
			this.hold(entry);
			return false;
		}
		if (decision === "cancel") {
			this.cancel(request.record.id);
			return false;
		}
		if (decision !== "allow") {
			this.hold(entry);
			return false;
		}
		this.permitted.add(entry);
		return true;
	}

	private hold(entry: string): void {
		this.port.discard(entry);
		this.issued.delete(entry);
		this.permitted.delete(entry);
	}

	private accepted(request: Request): void {
		if (request.record.policy) this.port.policy?.(request.record.policy)?.accept?.(this.input(request));
	}

	refresh(): void {
		if (!this.ready || this.paused) return;
		void this.prepare()
			.then(() => this.schedule())
			.catch((error) => this.retry(error));
	}

	private async prepare(): Promise<void> {
		if (!this.ready || this.paused) return;
		for (const request of this.pending.values()) {
			if (request.record.policy) {
				try {
					await this.authorize(request.entry);
				} catch (error) {
					this.retry(error);
				}
			}
		}
		this.enqueue(true);
	}

	private retry(error: unknown): void {
		this.port.warn(error);
		this.delay = Math.min(10_000, this.delay * 2);
		this.schedule(true);
	}

	toolResult(message: ToolResultMessage): boolean {
		return this.projections(message).some((request) => this.allowed(request.entry));
	}

	private projections(message: ToolResultMessage): Request[] {
		const details = message.details as { inputIds?: unknown } | undefined;
		if (!Array.isArray(details?.inputIds)) return [];
		return details.inputIds.flatMap((id) => {
			const request = typeof id === "string" ? this.requests.get(id) : undefined;
			return request?.record.toolCallId === message.toolCallId ? [request] : [];
		});
	}

	start(): void {
		if (this.ready) {
			this.refresh();
			return;
		}
		this.ready = true;
		this.paused = false;
		this.enqueue(true);
		this.refresh();
	}
	resume(): void {
		this.paused = false;
		this.enqueue();
	}
	async boundary(): Promise<void> {
		await this.prepare();
	}
	settle(aborted: boolean): void {
		if (aborted) this.suspend();
		// No input is in flight at this boundary. A failed projection may have
		// consumed a queue entry without fulfilling its durable request.
		for (const request of this.pending.values()) {
			if (!this.port.queued(request.entry)) this.issued.delete(request.entry);
		}
		this.enqueue(true);
		if (!aborted) this.refresh();
	}
	suspend(): void {
		this.paused = true;
		this.epoch++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
	close(): void {
		this.suspend();
		this.ready = false;
	}

	private enqueue(finished = false): void {
		if (!this.ready) return;
		for (const request of this.pending.values()) {
			if (request.record.policy && !this.permitted.has(request.entry)) continue;
			if (request.record.toolCallId && (!finished || this.port.executing(request.record.toolCallId))) continue;
			if (this.issued.has(request.entry) || this.port.queued(request.entry)) continue;
			this.port.queue({ ...request.record.message, role: "custom", timestamp: Date.now(), inputId: request.entry });
			this.issued.add(request.entry);
		}
	}

	private schedule(retry = false): void {
		const queued = () => [...this.pending.values()].some((request) => this.port.queued(request.entry));
		if (!this.ready || this.paused || this.timer || !this.port.idle() || (!retry && !queued())) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.prepare()
				.then(() => {
					if (this.paused || !this.port.idle() || !queued()) return;
					for (const request of this.pending.values()) if (this.port.queued(request.entry)) this.accepted(request);
					return this.port.start();
				})
				.catch((error) => this.retry(error));
		}, this.delay);
	}

	private updateBranch(): void {
		const leaf = this.manager.getLeafId();
		if (leaf === this.branchLeaf) return;
		const suffix: SessionEntry[] = [];
		let cursor = leaf;
		while (cursor && cursor !== this.branchLeaf) {
			const entry = this.manager.getEntry(cursor);
			if (!entry) throw new Error("Input admission branch has a missing parent");
			suffix.push(entry);
			cursor = entry.parentId;
		}
		if (cursor !== this.branchLeaf) this.visible.clear();
		for (const entry of suffix.reverse()) {
			if (entry.type === "custom_message" && entry.inputId) {
				const request = this.requests.get(entry.inputId);
				if (request) this.visible.set(request.record.id, request.entry);
			} else if (entry.type === "message" && entry.message.role === "toolResult") {
				for (const request of this.projections(entry.message)) {
					this.visible.set(request.record.id, request.entry);
				}
			}
		}
		this.branchLeaf = leaf;
	}
}
