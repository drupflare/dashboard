import {
	createAccounting,
	DEFAULT_OPTIONS,
	mechanism,
	monthOf,
	type ApplyAnswer,
	type CountingOptions,
	type CountWrite
} from './counting';
import { createFlusher } from './flush';

export type CountedView = {
	siteId: string;
	status: number;
	contentType: string | null;
	limit: number | null;
};

export type ViewCounter = {
	// never rejects and never throws; a counter that is down costs views, not responses
	count(view: CountedView, waitUntil: (promise: Promise<unknown>) => void): Promise<void>;
	// the views the counter acknowledged this month, as this isolate last heard; null when it has
	// not heard this month, so a stale total from last month never blocks
	acknowledged(siteId: string, now: number): number | null;
};

export type ViewCounterDeps = {
	origin: string;
	now(): number;
	sleep(ms: number): Promise<void>;
	send(write: CountWrite): Promise<ApplyAnswer>;
	options?: Partial<CountingOptions>;
	timeoutMs?: number;
};

// production counting is always hybrid: batched while a site is far from its limit, written through
// near it, so the acknowledged total a block reads is exact where it matters
export function createViewCounter(deps: ViewCounterDeps): ViewCounter {
	const heard = new Map<string, { month: string; total: number }>();

	const accounting = createAccounting({
		counting: mechanism('hybrid', deps.options),
		origin: deps.origin,
		now: deps.now,
		send: async (write) => {
			const answer = await deps.send(write);
			if (answer.ok)
				heard.set(write.siteId, { month: monthOf(write.hour), total: answer.total });
			return answer;
		},
		// every write is registered under the counting request's own waitUntil, passed to count
		waitUntil: () => undefined,
		timeoutMs: deps.timeoutMs
	});

	const flusher = createFlusher({
		sleep: deps.sleep,
		flushMs: deps.options?.flushMs ?? DEFAULT_OPTIONS.flushMs,
		maxCycles: (deps.options?.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts) + 1,
		flush: (retry) => accounting.flush(retry),
		pending: () => accounting.pending()
	});

	return {
		async count(view, waitUntil) {
			try {
				const done = accounting.count(view, waitUntil);
				flusher.arm(waitUntil);
				await done;
			} catch {
				// a counting failure never fails a response
			}
		},
		acknowledged(siteId, now) {
			const known = heard.get(siteId);
			return known !== undefined && known.month === monthOf(now) ? known.total : null;
		}
	};
}
