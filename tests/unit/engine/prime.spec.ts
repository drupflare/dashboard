import { describe, expect, it } from 'vitest';
import { HOUR_MS, hourOf } from '../../../dispatch/src/counting';
import {
	PRIME_MAX_VIEWS,
	PRIME_PREFIX,
	primeStage,
	type PrimeStore
} from '../../../engine/src/prime';
import { counterDouble, newSiteId } from '../dispatch/fakes';

const NOW = Date.UTC(2026, 10, 21, 15, 30);
const SITE = newSiteId();

function queue(entries: Record<string, string>) {
	const data = new Map(Object.entries(entries));
	const reads: string[] = [];
	const store: PrimeStore = {
		list: async ({ prefix }) => {
			reads.push(`list:${prefix}`);
			return {
				keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))
			};
		},
		get: async (key) => data.get(key) ?? null,
		delete: async (key) => void data.delete(key)
	};
	return { data, reads, store };
}

const run = (
	mode: string | undefined,
	q: ReturnType<typeof queue>,
	c = counterDouble(() => NOW)
) => ({
	c,
	done: primeStage({ mode, store: q.store, counter: c.stub, now: () => NOW })
});

describe('primeStage', () => {
	it('does nothing and reads nothing unless the stage switch is exactly 1', async () => {
		for (const mode of [undefined, '', '0', 'true', 'on']) {
			const q = queue({
				[`${PRIME_PREFIX}primeaaaa0001`]: JSON.stringify({ siteId: SITE, views: 5 })
			});
			const { c, done } = run(mode, q);
			expect(await done).toEqual([]);
			expect(q.reads).toEqual([]);
			expect(q.data.size).toBe(1);
			expect(c.applies).toHaveLength(0);
		}
	});

	it('writes exactly the queued views into the current hour under the key id and drops the key', async () => {
		const q = queue({
			[`${PRIME_PREFIX}primeaaaa0001`]: JSON.stringify({ siteId: SITE, views: 999_900 })
		});
		const { c, done } = run('1', q);
		expect(await done).toEqual([
			{ id: 'primeaaaa0001', siteId: SITE, views: 999_900, result: 'applied' }
		]);
		expect(c.applies).toHaveLength(1);
		expect(c.applies[0]).toMatchObject({
			siteId: SITE,
			hour: hourOf(NOW),
			origin: 'primeaaaa0001',
			ranges: [{ from: 1, to: 999_900 }],
			issued: 999_900,
			sync: true
		});
		expect(q.data.size).toBe(0);
		const counter = c.stub(SITE);
		expect(await counter.read(hourOf(NOW))).toMatchObject({ issued: 999_900, origins: 1 });
	});

	it('accepts the cap and refuses one view more, and a refusal leaves the counter alone', async () => {
		const q = queue({
			[`${PRIME_PREFIX}primeaaaa0001`]: JSON.stringify({
				siteId: SITE,
				views: PRIME_MAX_VIEWS
			}),
			[`${PRIME_PREFIX}primeaaaa0002`]: JSON.stringify({
				siteId: SITE,
				views: PRIME_MAX_VIEWS + 1
			})
		});
		const { c, done } = run('1', q);
		const out = await done;
		expect(out.map((o) => [o.id, o.result, o.code])).toEqual([
			['primeaaaa0001', 'applied', undefined],
			['primeaaaa0002', 'refused', 'too_many_views']
		]);
		expect(c.applies).toHaveLength(1);
		expect(q.data.size).toBe(0);
	});

	it('refuses a malformed entry, a zero count and a counter refusal without retrying them', async () => {
		const q = queue({
			[`${PRIME_PREFIX}primeaaaa0001`]: 'not json',
			[`${PRIME_PREFIX}primeaaaa0002`]: JSON.stringify({ siteId: SITE, views: 0 }),
			[`${PRIME_PREFIX}primeaaaa0003`]: JSON.stringify({ siteId: SITE, views: 1.5 }),
			[`${PRIME_PREFIX}primeaaaa0004`]: JSON.stringify({ views: 3 }),
			[`${PRIME_PREFIX}bad`]: JSON.stringify({ siteId: SITE, views: 3 })
		});
		const { c, done } = run('1', q);
		const out = await done;
		expect(out.map((o) => o.result)).toEqual([
			'refused',
			'refused',
			'refused',
			'refused',
			'refused'
		]);
		expect(out[4]?.code).toBe('bad_write');
		expect(c.applies).toHaveLength(1);
		expect(q.data.size).toBe(0);
	});

	it('keeps the key when the counter fails, and a second pass counts the views once', async () => {
		const q = queue({
			[`${PRIME_PREFIX}primeaaaa0001`]: JSON.stringify({ siteId: SITE, views: 40 })
		});
		const c = counterDouble(() => NOW);
		c.mode.fail = true;
		expect((await run('1', q, c).done)[0]?.result).toBe('retry');
		expect(q.data.size).toBe(1);
		c.mode.fail = false;
		expect((await run('1', q, c).done)[0]?.result).toBe('applied');
		const again = queue({
			[`${PRIME_PREFIX}primeaaaa0001`]: JSON.stringify({ siteId: SITE, views: 40 })
		});
		expect((await run('1', again, c).done)[0]?.result).toBe('applied');
		expect(await c.stub(SITE).read(hourOf(NOW))).toMatchObject({ issued: 40 });
		expect(hourOf(NOW) % HOUR_MS).toBe(0);
	});

	it('leaves keys outside its prefix alone', async () => {
		const q = queue({ 'sess:abc': 'x' });
		expect(await run('1', q).done).toEqual([]);
		expect(q.data.size).toBe(1);
	});
});
