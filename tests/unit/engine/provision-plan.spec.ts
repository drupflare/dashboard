import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import {
	InvalidLimitsError,
	InvalidSiteIdError,
	countCalls,
	dryRun,
	planResources,
	remainingResources,
	resourceName
} from '../../../engine/src/provision-plan';
import { run } from '../../../scripts/provision';

const limits = { kvNamespaces: 1000, requestsPerWindow: 1200, windowSeconds: 300 };

describe('planResources', () => {
	it('plans two KV namespaces and two buckets on the managed config', () => {
		const plan = planResources({ id: newId('site') }, 'managed');
		expect(plan.create.map((r) => [r.kind, r.binding])).toEqual([
			['kv', 'CONFIG_KV'],
			['kv', 'PAGE_KV'],
			['r2', 'FILES'],
			['r2', 'FILES_PRIVATE']
		]);
	});

	it('plans no bucket on the canonical config', () => {
		const plan = planResources({ id: newId('site') }, 'canonical');
		expect(plan.create.map((r) => r.kind)).toEqual(['kv', 'kv']);
	});

	it('adds a database last and only when asked', () => {
		const id = newId('site');
		expect(planResources({ id }, 'managed').create.some((r) => r.kind === 'd1')).toBe(false);
		const withDb = planResources({ id }, 'managed', { database: true });
		expect(withDb.create.at(-1)).toMatchObject({ kind: 'd1', binding: 'FLEET_DB' });
	});

	it('gives the same plan for the same site id and different names for different sites', () => {
		const id = newId('site');
		expect(planResources({ id }, 'managed')).toEqual(planResources({ id }, 'managed'));
		const names = (site: string) =>
			planResources({ id: site }, 'managed').create.map((r) => r.name);
		const other = names(newId('site'));
		for (const name of names(id)) expect(other).not.toContain(name);
	});

	it('rolls back in the reverse of the creation order', () => {
		for (const database of [false, true]) {
			const plan = planResources({ id: newId('site') }, 'managed', { database });
			expect(plan.rollback).toEqual([...plan.create].reverse());
		}
	});

	it('names resources so R2 and the account accept them', () => {
		const plan = planResources({ id: newId('site') }, 'managed', { database: true });
		for (const resource of plan.create) {
			expect(resource.name).toMatch(/^s-[0-9a-z]+-[a-z]+(-[a-z]+)?$/);
			expect(resource.name.length).toBeLessThanOrEqual(63);
		}
		expect(resourceName('site_abcdefgh', 'files')).toBe('s-abcdefgh-files');
	});

	it('refuses an id that is not a site id', () => {
		expect(() => planResources({ id: 'nope' }, 'managed')).toThrow(InvalidSiteIdError);
		expect(() => resourceName('org_abcdefgh', 'x')).toThrow(InvalidSiteIdError);
	});

	it('skips what an earlier attempt recorded', () => {
		const plan = planResources({ id: newId('site') }, 'managed');
		expect(remainingResources(plan, [])).toEqual(plan.create);
		expect(remainingResources(plan, [{ binding: 'CONFIG_KV' }]).map((r) => r.binding)).toEqual([
			'PAGE_KV',
			'FILES',
			'FILES_PRIVATE'
		]);
		expect(remainingResources(plan, plan.create)).toEqual([]);
	});
});

describe('dryRun', () => {
	const plan = planResources({ id: 'site_abcdefgh' }, 'managed');

	it('counts calls by kind', () => {
		expect(countCalls(plan)).toEqual({ creates: 4, lookups: 2, rollbackDeletes: 4 });
	});

	it('states the calls and both limits it touches, taking each from its argument', () => {
		const text = dryRun(plan, limits, { kvNamespaces: 120 });
		expect(text).toContain('4 to create');
		expect(text).toContain('10 at most');
		expect(text).toContain('2 added to 120, 122 of 1,000, within the limit');
		expect(text).toContain('10 of 1,200 requests per 5 minutes');
		const other = dryRun(
			plan,
			{ kvNamespaces: 50, requestsPerWindow: 40, windowSeconds: 600 },
			{ kvNamespaces: 49 }
		);
		expect(other).toContain('51 of 50, over the limit by 1');
		expect(other).toContain('10 of 40 requests per 10 minutes, 25.0%');
		expect(other).not.toContain('1,000');
		expect(other).not.toContain('1,200');
	});

	it('says so when the namespace count is unknown', () => {
		expect(dryRun(plan, limits, { kvNamespaces: null })).toContain('in use unknown');
	});

	it('lists the creation and rollback order', () => {
		const text = dryRun(plan, limits, { kvNamespaces: 0 });
		expect(text.indexOf('1. kv CONFIG_KV')).toBeLessThan(text.indexOf('3. r2 FILES'));
		expect(text.indexOf('1. delete r2')).toBeGreaterThan(text.indexOf('Roll back'));
	});

	it('refuses a limit that is not a positive number', () => {
		for (const bad of [0, -1, Number.NaN]) {
			expect(() =>
				dryRun(plan, { ...limits, requestsPerWindow: bad }, { kvNamespaces: 0 })
			).toThrow(InvalidLimitsError);
		}
	});
});

describe('scripts/provision', () => {
	const args = [
		'--site',
		'site_abcdefgh',
		'--config',
		'managed',
		'--kv-limit',
		'1000',
		'--rate-limit',
		'1200',
		'--window-seconds',
		'300'
	];

	it('prints the plan and exits 0', () => {
		const result = run(args);
		expect(result.code).toBe(0);
		expect(result.out).toContain('s-abcdefgh-files');
	});

	it('refuses --apply and calls nothing', () => {
		const result = run([...args, '--apply']);
		expect(result.code).toBe(2);
		expect(result.out).toContain('--apply is refused');
	});

	it('refuses a missing limit, a bad config and a bad site id', () => {
		expect(run(['--site', 'site_abcdefgh', '--config', 'managed']).code).toBe(1);
		expect(run(args.map((a) => (a === 'managed' ? 'free' : a))).code).toBe(1);
		expect(run(args.map((a) => (a === 'site_abcdefgh' ? 'nope' : a))).code).toBe(1);
		expect(run(['--bogus']).code).toBe(1);
	});

	it('prints usage for --help', () => {
		expect(run(['--help']).out).toContain('usage:');
	});

	it('takes the database and the namespace count', () => {
		const result = run([...args, '--database', '--kv-in-use', '10']);
		expect(result.out).toContain('FLEET_DB');
		expect(result.out).toContain('2 added to 10');
	});
});
