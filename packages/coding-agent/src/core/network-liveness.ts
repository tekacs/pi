import { networkInterfaces } from "node:os";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * A provider connection bound to a local address that has since disappeared
 * (an unplugged adapter, a DHCP change) never receives data or a reset, and a
 * long-thinking model legitimately sends nothing for minutes, so idle timeouts
 * cannot tell the two apart. Address removal can: while a model request is in
 * flight, local addresses are polled, and a request whose starting addresses
 * lost one is aborted and reported as a retryable lost connection.
 */
const POLL_MS = 5_000;
/** Bound on a provider that ignores the abort; the request then fails on our side. */
const ABORT_GRACE_MS = 10_000;

export type AddressSource = () => ReadonlySet<string>;

export function localAddresses(): ReadonlySet<string> {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) if (!entry.internal) addresses.add(entry.address);
	}
	return addresses;
}

interface Watcher {
	started: ReadonlySet<string>;
	lost(removed: string[]): void;
}

/** One poller shared by every in-flight request; it runs only while one exists. */
export class AddressWatch {
	private readonly watchers = new Set<Watcher>();
	private timer?: ReturnType<typeof setInterval>;
	private readonly addresses: AddressSource;
	private readonly pollMs: number;

	constructor(addresses: AddressSource = localAddresses, pollMs = POLL_MS) {
		this.addresses = addresses;
		this.pollMs = pollMs;
	}

	watch(lost: (removed: string[]) => void): () => void {
		const watcher: Watcher = { started: this.addresses(), lost };
		this.watchers.add(watcher);
		if (!this.timer) {
			this.timer = setInterval(() => this.poll(), this.pollMs);
			this.timer.unref?.();
		}
		return () => {
			this.watchers.delete(watcher);
			if (this.watchers.size === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		};
	}

	poll(): void {
		const current = this.addresses();
		for (const watcher of [...this.watchers]) {
			const removed = [...watcher.started].filter((address) => !current.has(address));
			if (removed.length > 0) watcher.lost(removed);
		}
	}
}

const sharedWatch = new AddressWatch();

function lostConnection(message: AssistantMessage, removed: string[]): AssistantMessage {
	return {
		...message,
		stopReason: "error",
		errorMessage: `Network connection lost: local address ${removed.join(", ")} was removed during the request`,
	};
}

/** An error outcome for a request that failed before the provider emitted anything. */
function failedBeforeStart(model: Model<Api>, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Wraps a stream function so a request whose local network address disappears is
 * aborted and settles as a retryable error instead of hanging or reading as a user abort.
 */
export function guardNetwork(streamFn: StreamFn, watch: AddressWatch = sharedWatch): StreamFn {
	return async (model, context, options) => {
		const network = new AbortController();
		let removed: string[] | undefined;
		const stop = watch.watch((lost) => {
			if (removed) return;
			removed = lost;
			network.abort(new Error(`Network connection lost: local address ${lost.join(", ")} was removed`));
		});
		const signal = options?.signal ? AbortSignal.any([options.signal, network.signal]) : network.signal;
		let inner: AssistantMessageEventStream;
		try {
			inner = await streamFn(model, context, { ...options, signal });
		} catch (error) {
			stop();
			throw error;
		}
		const outer = new AssistantMessageEventStream();
		const networkCaused = () => removed !== undefined && !options?.signal?.aborted;
		let partial: AssistantMessage | undefined;
		let settled = false;
		const settle = (event: AssistantMessageEvent) => {
			if (settled) return;
			settled = true;
			stop();
			if (event.type === "error" && networkCaused()) {
				outer.push({ type: "error", reason: "error", error: lostConnection(event.error, removed!) });
			} else {
				outer.push(event);
			}
			outer.end();
		};
		// A provider that never observes the abort still settles, as the same retryable error.
		network.signal.addEventListener(
			"abort",
			() => {
				const grace = setTimeout(() => {
					if (!settled) settle({ type: "error", reason: "error", error: partial ?? failedBeforeStart(model, "") });
				}, ABORT_GRACE_MS);
				grace.unref?.();
			},
			{ once: true },
		);
		const pump = async () => {
			for await (const event of inner) {
				if (settled) return;
				if ("partial" in event) partial = event.partial;
				if (event.type === "done" || event.type === "error") return settle(event);
				outer.push(event);
			}
			// The inner stream ended without a terminal event; its result is the outcome.
			const result = await inner.result();
			const reason = result.stopReason;
			if (reason === "error" || reason === "aborted") settle({ type: "error", reason, error: result });
			else if (reason === "pending")
				settle({ type: "error", reason: "error", error: { ...result, stopReason: "error" } });
			else settle({ type: "done", reason, message: result });
		};
		pump().catch((error: unknown) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const base = partial ?? failedBeforeStart(model, errorMessage);
			settle({ type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage } });
		});
		return outer;
	};
}
