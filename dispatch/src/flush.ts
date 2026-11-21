export type FlushDeps = {
	sleep(ms: number): Promise<void>;
	flushMs: number;
	// bounds one registration: a request's wait window is 30 s, so cycles times flushMs stays below it
	maxCycles: number;
	// sends everything unsent and settles when every write is answered or failed; true if it sent any
	flush(retry: boolean): Promise<boolean>;
	pending(): boolean;
};

export type Flusher = {
	// call after a view is counted, with the waitUntil of the request that counted it
	arm(waitUntil: (promise: Promise<unknown>) => void): void;
};

// a Worker has no timer between requests and a request's wait window ends, so every counted view
// that leaves work unsent holds its own bounded flush; the state lives in the counting entries,
// never in the flush, so a cancelled flush strands nothing and a later view arms a new one
export function createFlusher(deps: FlushDeps): Flusher {
	async function run(): Promise<void> {
		try {
			for (let cycle = 0; cycle < deps.maxCycles; cycle++) {
				await deps.sleep(deps.flushMs);
				// a flush that found nothing to send was covered by an earlier one, which owns any retry
				const sent = await deps.flush(cycle > 0);
				if (!sent || !deps.pending()) return;
			}
		} catch {
			// a flush failure never surfaces; the next counted view arms another
		}
	}

	return {
		arm(waitUntil) {
			if (deps.pending()) waitUntil(run());
		}
	};
}
