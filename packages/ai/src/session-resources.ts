import { combineAbortSignals } from "./utils/abort-signals.ts";

export type SessionResourceCleanup = (sessionId?: string) => void | Promise<void>;

export interface SessionOperation {
	readonly signal: AbortSignal;
	/** Original caller signal, retained across nested auth and provider operations. */
	readonly owner: AbortSignal | undefined;
	cancel(): void;
}

type PendingOperation = { cancel(): void; promise: Promise<unknown> };
const operations = new Map<string | undefined, Set<PendingOperation>>();
const owners = new WeakMap<AbortSignal, AbortSignal | undefined>();

/** Register before async setup so session cleanup also joins auth and payload hooks. */
export function sessionOperation<T>(
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	run: (operation: SessionOperation) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const combined = combineAbortSignals([signal, controller.signal]);
	const effective = combined.signal!;
	const owner = signal && owners.has(signal) ? owners.get(signal) : signal;
	owners.set(effective, owner);
	const cancel = () => controller.abort();
	const members = operations.get(sessionId) ?? new Set<PendingOperation>();
	operations.set(sessionId, members);
	const promise = Promise.resolve()
		.then(async () => {
			effective.throwIfAborted();
			const result = await run({ signal: effective, owner, cancel });
			effective.throwIfAborted();
			return result;
		})
		.finally(() => {
			combined.cleanup();
			members.delete(pending);
			if (members.size === 0 && operations.get(sessionId) === members) operations.delete(sessionId);
		});
	const pending = { cancel, promise };
	members.add(pending);
	return promise;
}

const sessionResourceCleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

/** Start every cleanup immediately; await the result to join all resource work. */
export async function cleanupSessionResources(sessionId?: string): Promise<void> {
	const pending = [...operations]
		.filter(([id]) => sessionId === undefined || id === sessionId)
		.flatMap(([, members]) => [...members]);
	for (const operation of pending) operation.cancel();
	const results = await Promise.allSettled([
		...pending.map((operation) => operation.promise.catch(() => {})),
		...[...sessionResourceCleanups].map(async (cleanup) => cleanup(sessionId)),
	]);
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length > 0) throw new AggregateError(errors, "Failed to cleanup session resources");
}
