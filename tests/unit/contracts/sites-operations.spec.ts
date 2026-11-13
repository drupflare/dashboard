import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import {
	DEFAULT_CHANGE_BUDGET,
	OPERATION_TYPES,
	changeBudgetSchema,
	computePlanDigest,
	operationSchema,
	planSchema,
	stepSchema,
	type Plan
} from '../../../contracts/src/operations';
import {
	ADMIN_PASSWORD_STATES,
	SITES_VERSION,
	SITE_CATEGORIES,
	SITE_CONFIGS,
	SITE_KINDS,
	categoryOfKind,
	cloudflareAccountId,
	hostname,
	scriptName,
	siteIdFromScript,
	siteSchema
} from '../../../contracts/src/sites';

const at = '2026-11-05T12:00:00Z';
const account = '0123456789abcdef0123456789abcdef';

describe('sites', () => {
	const site = {
		id: newId('site'),
		orgId: newId('org'),
		name: 'Campus Site',
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: account,
		state: 'active',
		ring: 'R3',
		primaryHostname: 'campus.drupflare.app',
		hostnames: ['campus.drupflare.app', 'www.example.edu'],
		release: { current: 'v1.0.4', available: 'v1.0.5' },
		admin: { username: 'admin', email: 'owner@example.edu', password: 'available' },
		box: { found: false, missingSince: null },
		createdAt: at,
		updatedAt: at
	};

	it('round-trips a site, with and without a primary hostname', () => {
		expect(siteSchema.parse(site)).toEqual(site);
		const bare = { ...site, primaryHostname: null, hostnames: [] };
		expect(siteSchema.parse(bare)).toEqual(bare);
	});

	it('rejects an unknown state, a bad ring, a bad id and a bad hostname', () => {
		expect(siteSchema.safeParse({ ...site, state: 'gone' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, ring: 'R6' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, id: 'nope' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, hostnames: ['Not A Host'] }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, createdAt: 'yesterday' }).success).toBe(false);
	});

	it('accepts the lifecycle states the plan lists and no others', () => {
		for (const state of ['active', 'suspended', 'tombstoned', 'purge-eligible', 'deleted']) {
			expect(siteSchema.safeParse({ ...site, state }).success).toBe(true);
		}
	});

	it('validates hostnames', () => {
		for (const good of ['a.co', 'x-y.example.edu', 'a.b.c.d.example.com']) {
			expect(hostname.safeParse(good).success, good).toBe(true);
		}
		for (const bad of [
			'localhost',
			'-a.com',
			'a-.com',
			'a..com',
			'a.c',
			'UPPER.com',
			'a b.com'
		]) {
			expect(hostname.safeParse(bad).success, bad).toBe(false);
		}
	});

	it('names a script from the id body, in a form a Worker name allows', () => {
		const name = scriptName(site.id);
		expect(name).toBe(`s-${site.id.slice('site_'.length)}`);
		expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
	});

	it('maps a script name back to its site id and refuses anything else', () => {
		expect(siteIdFromScript(scriptName(site.id))).toBe(site.id);
		expect(siteIdFromScript('s-short')).toBeNull();
		expect(siteIdFromScript('x-abcdefgh')).toBeNull();
		expect(siteIdFromScript(`s-${site.id}`)).toBeNull();
	});

	it('is version 1.3 and lists the two categories and the two configs', () => {
		expect(SITES_VERSION).toEqual({ major: 1, minor: 3 });
		expect(SITE_CATEGORIES).toEqual(['cms', 'workers']);
		expect(SITE_CONFIGS).toEqual(['managed', 'canonical']);
	});

	it('puts Drupal in the cms category and every other kind in workers', () => {
		expect(categoryOfKind('drupal')).toBe('cms');
		for (const kind of SITE_KINDS.filter((item) => item !== 'drupal')) {
			expect(categoryOfKind(kind)).toBe('workers');
		}
	});

	it('parses a 1.0 document by giving it the category of its kind, the canonical config and no account', () => {
		const {
			category: _c,
			config: _f,
			accountId: _a,
			release: _r,
			admin: _d,
			box: _b,
			...old
		} = site;
		expect(siteSchema.parse(old)).toEqual({
			...old,
			category: 'cms',
			config: 'canonical',
			accountId: null,
			release: { current: null, available: null },
			admin: { username: null, email: null, password: 'unknown' },
			box: { found: false, missingSince: null }
		});
		const worker = siteSchema.parse({ ...old, kind: 'nuxtpress' });
		expect(worker).toMatchObject({ kind: 'nuxtpress', category: 'workers' });
	});

	it('parses every password state and refuses one it does not know', () => {
		for (const password of ADMIN_PASSWORD_STATES) {
			const stated = { ...site, admin: { username: null, email: null, password } };
			expect(siteSchema.parse(stated)).toEqual(stated);
		}
		const odd = { ...site, admin: { ...site.admin, password: 'shown' } };
		expect(siteSchema.safeParse(odd).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, admin: { username: null } }).success).toBe(false);
	});

	it('keeps a stated box state and refuses a half-stated one', () => {
		const gone = { ...site, box: { found: true, missingSince: at } };
		expect(siteSchema.parse(gone)).toEqual(gone);
		expect(siteSchema.safeParse({ ...site, box: { found: true } }).success).toBe(false);
		expect(
			siteSchema.safeParse({ ...site, box: { found: true, missingSince: 'x' } }).success
		).toBe(false);
	});

	it('keeps a stated category, config and account over the defaults', () => {
		const stated = { ...site, kind: 'smoke', category: 'workers', config: 'canonical' };
		expect(siteSchema.parse(stated)).toEqual(stated);
		expect(siteSchema.parse({ ...site, accountId: null }).accountId).toBeNull();
	});

	it('refuses a category that does not match the kind, an unknown config and a bad account id', () => {
		expect(siteSchema.safeParse({ ...site, category: 'workers' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, kind: 'smoke' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, config: 'free' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, accountId: 'acct-1' }).success).toBe(false);
		expect(siteSchema.safeParse({ ...site, accountId: account.toUpperCase() }).success).toBe(
			false
		);
		expect(siteSchema.safeParse('not an object').success).toBe(false);
		expect(siteSchema.safeParse({ ...site, kind: 'wordpress' }).success).toBe(false);
	});

	it('accepts a 32 character lowercase hex account id and nothing else', () => {
		expect(cloudflareAccountId.safeParse(account).success).toBe(true);
		for (const bad of ['', account.slice(1), `${account}0`, 'g'.repeat(32)]) {
			expect(cloudflareAccountId.safeParse(bad).success, bad).toBe(false);
		}
	});
});

describe('operations', () => {
	const plan: Plan = {
		type: 'site.upgrade',
		targetIds: ['site_aaaaaaaa'],
		preconditions: ['lease held'],
		steps: [
			{ id: 'snapshot', name: 'Take a snapshot' },
			{ id: 'deploy', name: 'Deploy' }
		],
		blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 1 },
		rollbackPoint: 'bookmark-1'
	};

	it('lists the 34 operation types of the plan', () => {
		expect(OPERATION_TYPES).toHaveLength(34);
		expect(new Set(OPERATION_TYPES).size).toBe(34);
	});

	it('round-trips a plan and a step, and rejects an empty plan', () => {
		expect(planSchema.parse(plan)).toEqual(plan);
		expect(planSchema.safeParse({ ...plan, steps: [] }).success).toBe(false);
		expect(planSchema.safeParse({ ...plan, type: 'site.explode' }).success).toBe(false);
		const step = {
			id: 'deploy',
			name: 'Deploy',
			state: 'running',
			attempt: 1,
			startedAt: at,
			finishedAt: null,
			error: null
		};
		expect(stepSchema.parse(step)).toEqual(step);
		expect(stepSchema.safeParse({ ...step, attempt: -1 }).success).toBe(false);
		expect(stepSchema.safeParse({ ...step, state: 'maybe' }).success).toBe(false);
	});

	it('gives the same digest for the same plan and a different one for any change', async () => {
		const digest = await computePlanDigest(plan);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(await computePlanDigest(structuredClone(plan))).toBe(digest);
		expect(await computePlanDigest({ ...plan, rollbackPoint: null })).not.toBe(digest);
		expect(await computePlanDigest({ ...plan, steps: [...plan.steps].reverse() })).not.toBe(
			digest
		);
	});

	it('does not depend on key order when digesting', async () => {
		const reordered = JSON.parse(
			JSON.stringify(Object.fromEntries(Object.entries(plan).reverse()))
		) as Plan;
		expect(await computePlanDigest(reordered)).toBe(await computePlanDigest(plan));
	});

	it('refuses to digest an invalid plan', async () => {
		await expect(computePlanDigest({ ...plan, steps: [] })).rejects.toThrow();
	});

	it('carries the plan change budget by default and validates overrides', () => {
		expect(changeBudgetSchema.parse(DEFAULT_CHANGE_BUDGET)).toEqual(DEFAULT_CHANGE_BUDGET);
		expect(DEFAULT_CHANGE_BUDGET.maxDestructiveSites).toBe(5);
		expect(DEFAULT_CHANGE_BUDGET.maxConcurrentProductionDeploys).toBe(10);
		expect(
			changeBudgetSchema.safeParse({ ...DEFAULT_CHANGE_BUDGET, maxDestructiveSites: 0 })
				.success
		).toBe(false);
	});

	it('round-trips an operation and rejects a bad digest, epoch and idempotency key', async () => {
		const operation = {
			id: newId('op'),
			orgId: newId('org'),
			type: 'site.upgrade',
			status: 'running',
			idempotencyKey: 'idem-1',
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			fencingEpoch: 4,
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			cursor: 'deploy',
			steps: [],
			verification: 'pending',
			finalObservation: null,
			budget: DEFAULT_CHANGE_BUDGET,
			createdAt: at,
			updatedAt: at
		};
		expect(operationSchema.parse(operation)).toEqual(operation);
		expect(operationSchema.safeParse({ ...operation, planDigest: 'abc' }).success).toBe(false);
		expect(operationSchema.safeParse({ ...operation, fencingEpoch: -1 }).success).toBe(false);
		expect(operationSchema.safeParse({ ...operation, idempotencyKey: '' }).success).toBe(false);
		expect(operationSchema.safeParse({ ...operation, status: 'lost' }).success).toBe(false);
		const done = { ...operation, finalObservation: { at, summary: 'all healthy' } };
		expect(operationSchema.parse(done)).toEqual(done);
	});
});
