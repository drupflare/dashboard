import { getCurrentScope, onScopeDispose } from 'vue';

export interface PollOptions {
	minMs?: number;
	maxMs?: number;
	factor?: number;
}

const DEFAULTS: Required<PollOptions> = { minMs: 2000, maxMs: 60_000, factor: 2 };

function pollDelay(tick: number, options: PollOptions = {}): number {
	const { minMs, maxMs, factor } = { ...DEFAULTS, ...options };
	return Math.min(maxMs, minMs * factor ** tick);
}

// a failed call keeps the poll going on the same schedule; the task reports its own errors
export function usePoll(task: () => Promise<unknown>, options: PollOptions = {}) {
	let tick = 0;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight: Promise<void> | null = null;

	const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

	function clear() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function schedule() {
		clear();
		if (!running || hidden()) return;
		timer = setTimeout(() => void refresh(), pollDelay(tick, options));
	}

	function refresh(): Promise<void> {
		if (inflight) return inflight;
		clear();
		inflight = (async () => {
			try {
				await task();
			} catch {
				// the schedule continues; a failing task backs off like a slow one
			} finally {
				inflight = null;
				tick++;
				schedule();
			}
		})();
		return inflight;
	}

	function onVisibility() {
		if (!running) return;
		if (hidden()) clear();
		else if (timer === undefined && !inflight) void refresh();
	}

	function start() {
		if (running) return;
		running = true;
		if (typeof document !== 'undefined')
			document.addEventListener('visibilitychange', onVisibility);
		if (hidden()) return;
		void refresh();
	}

	function stop() {
		running = false;
		clear();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibility);
		}
	}

	if (getCurrentScope()) onScopeDispose(stop);

	return { start, stop, refresh };
}
