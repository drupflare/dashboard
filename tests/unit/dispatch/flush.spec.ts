import { describe, expect, it, vi } from 'vitest';
import { sizeOf, type CountingOptions, type MechanismName } from '../../../dispatch/src/counting';
import { createSpike } from '../../../dispatch/src/spike';
import { counterDouble } from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const SITE = 'site_flushspec001';
const HOUR0 = Date.UTC(2026, 10, 6, 12);
const START = HOUR0 + 1_000;
const HTML = 'text/html; charset=utf-8';
const WINDOW_MS = 30_000;

type Owner = { cancelAt: number; registered: Promise<unknown>[] };

// a Worker as the live readings describe it: Date.now() holds still during a timer and moves only
// when I/O happens; a promise registered under a request stops running 30 s after that request
function runtime(options: { frozen: boolean; counting?: Partial<CountingOptions> }) {
	let virtual = 0;
	let seen = START;
	let current: Owner | null = null;
	let seq = 0;
	const timers: { at: number; seq: number; owner: Owner | null; resolve(): void }[] = [];
	const counter = counterDouble(() => seen);
	const refresh = () => void (seen = START + virtual);
	const stub = (siteId: string) => {
		const inner = counter.stub(siteId);
		return {
			...inner,
			apply: async (write: Parameters<typeof inner.apply>[0]) => {
				refresh();
				return inner.apply(write);
			}
		};
	};
	const spike = createSpike({
		controlKey: 'unused',
		origin: 'isolateone01',
		now: () => seen,
		sleep: (ms) =>
			new Promise<void>((resolve) => {
				timers.push({ at: virtual + ms, seq: seq++, owner: current, resolve });
			}),
		readMechanism: async () => null,
		counter: stub,
		evict: () => 0,
		options: { flushMs: 5_000, ...options.counting }
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const rt = {
		counter,
		spike,
		now: () => seen,
		clock: () => virtual,
		// one request that counts a view and answers at once
		async request(name: MechanismName, siteId = SITE) {
			refresh();
			const owner: Owner = { cancelAt: virtual + WINDOW_MS, registered: [] };
			const waitUntil = (promise: Promise<unknown>) => {
				if (virtual > owner.cancelAt) throw new Error('waitUntil after the window');
				owner.registered.push(promise);
			};
			spike.bind(waitUntil);
			current = owner;
			const done = spike.count(
				name,
				{ siteId, status: 200, contentType: HTML, limit: null },
				waitUntil
			);
			current = null;
			await done;
			await settle();
			return owner;
		},
		async advance(ms: number) {
			const target = virtual + ms;
			for (;;) {
				timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
				const next = timers[0];
				if (!next || next.at > target) break;
				timers.shift();
				virtual = next.at;
				if (!options.frozen) refresh();
				if (next.owner && virtual > next.owner.cancelAt) continue;
				current = next.owner;
				next.resolve();
				await settle();
				current = null;
			}
			virtual = target;
			if (!options.frozen) refresh();
		},
		timers: () => timers.length,
		async landed(siteId = SITE) {
			const row = await counter.stub(siteId).read(HOUR0);
			return row ? sizeOf(row.batches) : 0;
		}
	};
	return rt;
}

describe('tail flush', () => {
	for (const name of ['batched', 'hybrid'] as const) {
		it(`${name}: a small burst reaches the counter after one flush interval, frozen clock`, async () => {
			const rt = runtime({ frozen: true });
			for (let i = 0; i < 7; i++) await rt.request(name);
			expect(await rt.landed()).toBe(0);
			await rt.advance(6_000);
			expect(await rt.landed()).toBe(7);
		});

		it(`${name}: traffic that outlasts the first request's window ends with every view counted`, async () => {
			const rt = runtime({ frozen: false });
			let counted = 0;
			for (let i = 0; i < 16; i++) {
				await rt.request(name);
				counted++;
				await rt.advance(4_000);
			}
			await rt.advance(6_000);
			expect(await rt.landed()).toBe(counted);
		});

		it(`${name}: a burst that ends mid-batch is complete one interval after its last view`, async () => {
			const rt = runtime({ frozen: true });
			for (let i = 0; i < 120; i++) {
				await rt.request(name);
				await rt.advance(5);
			}
			expect(await rt.landed()).toBe(100);
			await rt.advance(5_000);
			expect(await rt.landed()).toBe(120);
			await rt.advance(60_000);
			expect(await rt.landed()).toBe(120);
			expect(rt.timers()).toBe(0);
		});
	}

	it('registers each flush under the waitUntil of the request that counted the view', async () => {
		const rt = runtime({ frozen: true });
		const owners = [];
		for (let i = 0; i < 3; i++) owners.push(await rt.request('batched'));
		const decoy: Promise<unknown>[] = [];
		rt.spike.bind((promise) => void decoy.push(promise));
		expect(owners.map((o) => o.registered.length)).toEqual([1, 1, 1]);
		expect(decoy).toHaveLength(0);
	});

	it('arms nothing for a view that left no work unsent', async () => {
		const rt = runtime({ frozen: true, counting: { batchSize: 1 } });
		const owner = await rt.request('batched');
		expect(rt.timers()).toBe(0);
		expect(owner.registered).toHaveLength(1);
		expect(await rt.landed()).toBe(1);
	});

	it('sends the same pending work once, however many views armed a flush', async () => {
		const rt = runtime({ frozen: true });
		for (let i = 0; i < 10; i++) await rt.request('batched');
		expect(rt.timers()).toBe(10);
		await rt.advance(6_000);
		expect(rt.counter.applies).toHaveLength(1);
		expect(rt.counter.applies[0]?.ranges).toEqual([{ from: 1, to: 10 }]);
		await rt.advance(60_000);
		expect(rt.counter.applies).toHaveLength(1);
	});

	it('keeps no flush state when a registered flush is cancelled before it fires', async () => {
		const rt = runtime({ frozen: true, counting: { flushMs: 40_000 } });
		await rt.request('batched');
		await rt.advance(50_000);
		expect(await rt.landed()).toBe(0);
		await rt.request('batched');
		await rt.advance(41_000);
		expect(await rt.landed()).toBe(2);
	});

	describe('isolate death', () => {
		const run = async (gated: boolean) => {
			const rt = runtime({ frozen: true });
			const arrivals: number[] = [];
			const KILL_MS = 12_000;
			while (rt.clock() < KILL_MS - 100) {
				await rt.request('batched');
				arrivals.push(rt.clock());
				await rt.advance(100);
			}
			if (gated) rt.counter.mode.gate = new Promise<void>(() => undefined);
			await rt.advance(KILL_MS - rt.clock());
			const lastInterval = arrivals.filter((at) => at > KILL_MS - 5_000).length;
			return { lost: arrivals.length - (await rt.landed()), lastInterval, rt };
		};

		it('loses at most the views of the last flush interval plus one batch', async () => {
			for (const gated of [false, true]) {
				const { lost, lastInterval } = await run(gated);
				expect(lost).toBeLessThanOrEqual(lastInterval + 50);
			}
		});

		it('loses exactly the unsent views when killed before the first flush fires', async () => {
			const rt = runtime({ frozen: true });
			for (let i = 0; i < 10; i++) await rt.request('batched');
			await rt.advance(4_900);
			expect(await rt.landed()).toBe(0);
		});

		it('loses nothing the flush interval has already covered', async () => {
			const { lost, lastInterval } = await run(false);
			expect(lost).toBeLessThanOrEqual(lastInterval);
		});
	});

	describe('counter outage', () => {
		it('retries a failed range on later cycles and lands it', async () => {
			const rt = runtime({ frozen: true });
			rt.counter.mode.fail = true;
			for (let i = 0; i < 3; i++) await rt.request('batched');
			await rt.advance(6_000);
			expect(await rt.landed()).toBe(0);
			rt.counter.mode.fail = false;
			await rt.advance(6_000);
			expect(await rt.landed()).toBe(3);
		});

		it('gives a range up after maxAttempts and reports it as issued but unacked', async () => {
			const rt = runtime({ frozen: true });
			rt.counter.mode.fail = true;
			for (let i = 0; i < 3; i++) await expect(rt.request('batched')).resolves.toBeDefined();
			await rt.advance(60_000);
			expect(rt.timers()).toBe(0);
			expect(rt.counter.applies.length).toBeLessThanOrEqual(5);
			rt.counter.mode.fail = false;
			await rt.request('batched');
			await rt.advance(6_000);
			const row = await rt.counter.stub(SITE).read(HOUR0);
			expect(row?.issued).toBe(4);
			expect(sizeOf(row?.batches ?? [])).toBe(1);
		});

		it('never fails the response when the counter is down', async () => {
			const rt = runtime({ frozen: true });
			rt.counter.mode.fail = true;
			await expect(rt.request('write-through')).resolves.toBeDefined();
			await expect(rt.request('hybrid')).resolves.toBeDefined();
		});
	});
});
