import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePoll } from '~/composables/usePoll';

const options = { minMs: 1000, maxMs: 8000, factor: 2 };

describe('usePoll', () => {
	let hidden = false;
	const listeners = new Set<() => void>();

	const setVisibility = (state: 'hidden' | 'visible') => {
		hidden = state === 'hidden';
		for (const listener of listeners) listener();
	};

	beforeEach(() => {
		vi.useFakeTimers();
		hidden = false;
		vi.stubGlobal('document', {
			get visibilityState() {
				return hidden ? 'hidden' : 'visible';
			},
			addEventListener: (_: string, listener: () => void) => listeners.add(listener),
			removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
		});
	});

	afterEach(() => {
		listeners.clear();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('backs off between calls and never waits longer than the ceiling', async () => {
		const starts: number[] = [];
		const gaps: number[] = [];
		const poll = usePoll(async () => {
			const last = starts.at(-1);
			if (last !== undefined) gaps.push(Date.now() - last);
			starts.push(Date.now());
		}, options);
		poll.start();
		await vi.advanceTimersByTimeAsync(120_000);
		poll.stop();

		expect(gaps.length).toBeGreaterThan(3);
		// the first wait after the first call is minMs times factor, one tick into the schedule
		expect(gaps[0]).toBe(options.minMs * options.factor);
		gaps.slice(1).forEach((gap, i) => {
			expect(gap).toBeGreaterThanOrEqual(gaps[i] ?? 0);
		});
		expect(Math.max(...gaps)).toBe(options.maxMs);
	});

	it('never runs two calls at once, even when a call is slower than the interval', async () => {
		let running = 0;
		let peak = 0;
		let calls = 0;
		const poll = usePoll(async () => {
			calls++;
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			running--;
		}, options);
		poll.start();
		await vi.advanceTimersByTimeAsync(60_000);
		poll.stop();

		expect(calls).toBeGreaterThan(1);
		expect(peak).toBe(1);
	});

	it('stops scheduling after stop', async () => {
		let calls = 0;
		const poll = usePoll(async () => {
			calls++;
		}, options);
		poll.start();
		await vi.advanceTimersByTimeAsync(5000);
		poll.stop();
		const atStop = calls;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toBe(atStop);
	});

	it('pauses while the tab is hidden and resumes when it is shown', async () => {
		let calls = 0;
		const poll = usePoll(async () => {
			calls++;
		}, options);
		poll.start();
		await vi.advanceTimersByTimeAsync(1000);
		setVisibility('hidden');
		const whileHidden = calls;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toBe(whileHidden);

		setVisibility('visible');
		expect(calls).toBeGreaterThan(whileHidden);
		poll.stop();
	});
});
