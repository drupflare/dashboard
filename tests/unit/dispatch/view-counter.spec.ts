import { describe, expect, it } from 'vitest';
import { applyIn, type ApplyAnswer, type CountWrite } from '../../../dispatch/src/counting';
import { createViewCounter } from '../../../dispatch/src/view-counter';
import { fakeClock, memoryKv } from './fakes';

const HTML = 'text/html';
const SITE = 'site_a';

function setup(opts: { batchSize?: number; flushMs?: number } = {}) {
	const clock = fakeClock();
	const kv = memoryKv();
	const writes: CountWrite[] = [];
	const down = { value: false };
	const waiting: (() => void)[] = [];
	const pending: Promise<unknown>[] = [];
	const counter = createViewCounter({
		origin: 'origin12345678',
		now: clock.now,
		sleep: () => new Promise<void>((resolve) => void waiting.push(resolve)),
		send: async (write): Promise<ApplyAnswer> => {
			writes.push(structuredClone(write));
			if (down.value) throw new Error('counter down');
			return applyIn(kv, write, clock.now(), SITE);
		},
		options: { batchSize: opts.batchSize ?? 1_000, flushMs: opts.flushMs ?? 5_000 },
		timeoutMs: 50
	});
	const view = (status = 200, type: string | null = HTML, limit: number | null = null) =>
		counter.count(
			{ siteId: SITE, status, contentType: type, limit },
			(p) => void pending.push(p)
		);
	const wake = async () => {
		for (const resolve of waiting.splice(0)) resolve();
		await Promise.all(pending.splice(0));
	};
	return { clock, kv, writes, down, counter, view, wake, waiting };
}

describe('the view counter', () => {
	it('learns the total from the first view, which it writes through', async () => {
		const c = setup();
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBeNull();
		await c.view(200, HTML, 100);
		expect(c.writes).toHaveLength(1);
		expect(c.writes[0]?.sync).toBe(true);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(1);
	});

	it('counts only 2xx text/html', async () => {
		const c = setup();
		for (const [status, type] of [
			[404, HTML],
			[500, HTML],
			[200, 'application/json'],
			[200, null],
			[302, HTML]
		] as const) {
			await c.view(status, type, 100);
		}
		expect(c.writes).toHaveLength(0);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBeNull();
	});

	it('writes through at the limit, so the acknowledged total is exact there', async () => {
		const c = setup();
		for (let n = 1; n <= 6; n++) await c.view(200, HTML, 3);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(6);
		expect(c.writes.filter((w) => w.sync)).toHaveLength(5);
	});

	it('sends the tail of a batch when its timer fires, with a frozen clock', async () => {
		const c = setup();
		for (let n = 0; n < 5; n++) await c.view(200, HTML, 1_000);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(1);
		await c.wake();
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(5);
	});

	it('never rejects when the counter is down, and keeps the range to retry', async () => {
		const c = setup();
		c.down.value = true;
		await expect(c.view(200, HTML, 100)).resolves.toBeUndefined();
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBeNull();
		c.down.value = false;
		await c.view(200, HTML, 100);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(2);
	});

	it('ignores a total heard in an earlier month', async () => {
		const c = setup();
		await c.view(200, HTML, 100);
		expect(c.counter.acknowledged(SITE, c.clock.now())).toBe(1);
		const nextMonth = c.clock.now() + 45 * 24 * 3_600_000;
		expect(c.counter.acknowledged(SITE, nextMonth)).toBeNull();
	});

	it('keeps sites apart', async () => {
		const c = setup();
		await c.view(200, HTML, 100);
		expect(c.counter.acknowledged('site_other', c.clock.now())).toBeNull();
	});
});
