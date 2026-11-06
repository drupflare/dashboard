import { describe, expect, it } from 'vitest';
import { scriptName, type SitePlane } from '../../../contracts/src/sites';
import { RateLimitedError } from '../../../engine/src/account-usage';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import {
	assertOwned,
	attachRoute,
	checkRoute,
	claimResource,
	claimScript,
	D1ResourceLedger,
	ForeignResourceError,
	LedgerConflictError,
	NotOwnedError,
	ownedDelete,
	OWNERSHIP_ERROR_CODES,
	purgeRows,
	reconcileSite,
	ResourceMissingError,
	RouteShadowError,
	ScriptChangedError,
	stateOf,
	sweepLeaks,
	type Claim,
	type LedgerRow,
	type OwnedRef
} from '../../../engine/src/ownership';
import { resourceName } from '../../../engine/src/provision-plan';
import { PermanentError } from '../../../engine/src/step';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	planSiteDelete,
	planSitePurge,
	runSiteDelete,
	runSitePurge
} from '../../../engine/src/workflows/site-delete';
import {
	beginCreate,
	Killed,
	makeRunner,
	makeWorld,
	memoryD1,
	snapshotWorld,
	type Memo,
	type RunnerScript,
	type World
} from './fakes';

const SITE = `site_${'s'.repeat(26)}`;
const ACCOUNT = 'a'.repeat(32);
const OP = `op_${'p'.repeat(26)}`;
const OTHER_SITE = `site_${'x'.repeat(26)}`;

const tripped = new Set<string>();

async function trip(work: () => unknown): Promise<Error & { code: string }> {
	try {
		await work();
	} catch (error) {
		const typed = error as Error & { code: string };
		tripped.add(typed.code);
		return typed;
	}
	throw new Error('expected a typed refusal and none came');
}

// names that a site of ours would use, held by someone else and not recorded anywhere
const lookAlikes = (site: string) => ({
	kv: [resourceName(site, 'config'), resourceName(site, 'page')],
	r2: [resourceName(site, 'files'), resourceName(site, 'files-private')],
	d1: [resourceName(site, 'db')],
	script: scriptName(site)
});

async function selfWorld(
	options: Parameters<typeof makeWorld>[0] = {},
	seed: Parameters<World['cf']['seedCustomer']>[0] = lookAlikes(OTHER_SITE)
) {
	const world = await makeWorld({ plane: 'self-managed', ...options });
	world.cf.seedCustomer(seed);
	return world;
}

async function start(world: World) {
	await beginCreate(world);
}

function run(world: World, memo: Memo = new Map(), script: RunnerScript = {}) {
	return runSiteCreate(makeRunner(memo, script).runner, world.deps, world.input);
}

async function begin(world: World, id: string, plan: ReturnType<typeof planSiteDelete>) {
	const operation = newOperation({
		id,
		orgId: world.orgId,
		idempotencyKey: `key-${id}`,
		frozen: await freezePlan(plan),
		verification: 'not-required',
		now: world.clock.now()
	});
	await world.store.begin({ operation, accountId: world.accountId, siteId: world.siteId });
}

async function remove(world: World) {
	const id = `op_${'d'.repeat(26)}`;
	await begin(world, id, planSiteDelete({ siteId: world.siteId }));
	return runSiteDelete(makeRunner(new Map()).runner, world.deps, {
		operationId: id,
		siteId: world.siteId,
		accountId: world.accountId,
		hostnames: [world.input.hostname]
	});
}

async function purge(world: World, plane: SitePlane = world.input.site.plane) {
	const id = `op_${'u'.repeat(26)}`;
	await begin(world, id, planSitePurge({ siteId: world.siteId }));
	return runSitePurge(makeRunner(new Map()).runner, world.deps, {
		operationId: id,
		siteId: world.siteId,
		accountId: world.accountId,
		subdomain: world.input.subdomain,
		confirm: world.siteId,
		holdUntil: world.clock.now(),
		plane
	});
}

const claimOf = (world: World, over: Partial<Claim> = {}): Claim => ({
	siteId: world.siteId,
	accountId: world.accountId,
	operationId: world.operationId,
	plane: world.input.site.plane,
	...over
});

type Deep = Record<string, unknown[]>;

// every item the account held before is still there, unchanged
function expectKept(before: string, after: string) {
	const was = JSON.parse(before) as Deep;
	const now = JSON.parse(after) as Deep;
	for (const key of Object.keys(was)) {
		const kept = new Set((now[key] ?? []).map((item) => JSON.stringify(item)));
		for (const item of was[key] ?? []) expect(kept, key).toContain(JSON.stringify(item));
	}
}

// nothing of ours is left: the account lists exactly what it listed before
function expectBack(before: string, after: string) {
	const was = JSON.parse(before) as Deep;
	const now = JSON.parse(after) as Deep;
	for (const key of ['kv', 'r2', 'd1', 'scripts', 'routes'])
		expect(now[key], key).toEqual(was[key]);
	expectKept(before, after);
}

const FORWARD = [
	'start',
	'lease',
	'reserve-name',
	'resource.CONFIG_KV',
	'resource.PAGE_KV',
	'resource.FILES',
	'resource.FILES_PRIVATE',
	'assets.session',
	'assets.upload.0',
	'assets.upload.2',
	'assets.complete',
	'upload-script',
	'authority',
	'route',
	'first-run',
	'verify',
	'activate'
];

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
	id: 'res_1',
	siteId: SITE,
	accountId: ACCOUNT,
	kind: 'kv',
	binding: 'CONFIG_KV',
	name: 'n',
	providerId: 'kv-1',
	createdByOperation: OP,
	createdAt: 1,
	missingAt: null,
	deletedAt: null,
	fingerprint: null,
	...over
});

const ref = (over: Partial<OwnedRef> = {}): OwnedRef => ({
	siteId: SITE,
	accountId: ACCOUNT,
	kind: 'kv',
	id: 'kv-1',
	action: 'delete',
	...over
});

describe('the ledger over D1', () => {
	function ledger() {
		const { db } = memoryD1();
		return new D1ResourceLedger(db);
	}
	const intent = (binding = 'CONFIG_KV', siteId = SITE) => ({
		siteId,
		accountId: ACCOUNT,
		kind: 'kv' as const,
		binding,
		name: `name-${binding}`,
		operationId: OP
	});

	it('records an intent with no provider id and returns the same row for a repeat', async () => {
		const store = ledger();
		const first = await store.intend(intent(), 10);
		expect(first.created).toBe(true);
		expect(first.row.providerId).toBeNull();
		expect(stateOf(first.row)).toBe('intent');
		const again = await store.intend(intent(), 20);
		expect(again.created).toBe(false);
		expect(again.row.id).toBe(first.row.id);
		expect(await store.live(SITE)).toHaveLength(1);
	});

	it('fills the id once, takes the same id again and refuses another', async () => {
		const store = ledger();
		const { row: made } = await store.intend(intent(), 10);
		await store.fill(made.id, 'kv-1', 'v1');
		await store.fill(made.id, 'kv-1');
		const [filled] = await store.live(SITE);
		expect(stateOf(filled!)).toBe('live');
		expect(filled?.fingerprint).toBe('v1');
		const clash = await trip(() => store.fill(made.id, 'kv-2'));
		expect(clash).toBeInstanceOf(LedgerConflictError);
	});

	it('refuses an id another live row of the account already holds', async () => {
		const store = ledger();
		const { row: a } = await store.intend(intent('A'), 1);
		const { row: b } = await store.intend(intent('B'), 1);
		await store.fill(a.id, 'kv-1');
		const clash = await trip(() => store.fill(b.id, 'kv-1'));
		expect(clash).toBeInstanceOf(LedgerConflictError);
		expect(stateOf((await store.live(SITE)).find((r) => r.id === b.id)!)).toBe('intent');
	});

	it('marks a row missing and then deleted, and a deleted binding can be intended again', async () => {
		const store = ledger();
		const { row: made } = await store.intend(intent(), 1);
		await store.fill(made.id, 'kv-1');
		await store.markMissing(made.id, 5);
		expect(stateOf((await store.live(SITE))[0]!)).toBe('missing');
		await store.markDeleted(made.id, 6);
		expect(await store.live(SITE)).toEqual([]);
		expect(await store.all(SITE)).toHaveLength(1);
		const next = await store.intend(intent(), 7);
		expect(next.created).toBe(true);
		await store.fill(next.row.id, 'kv-2');
	});

	it('keeps an id from being booked twice in an account, deleted rows included, except a script name', async () => {
		const store = ledger();
		const { row: first } = await store.intend(intent('A'), 1);
		await store.fill(first.id, 'kv-1');
		await store.markDeleted(first.id, 2);
		const { row: second } = await store.intend(intent('B'), 3);
		const clash = await trip(() => store.fill(second.id, 'kv-1'));
		expect(clash).toBeInstanceOf(LedgerConflictError);
		const script = { ...intent('SCRIPT'), kind: 'script' as const, name: 's-a' };
		const { row: one } = await store.intend(script, 4);
		await store.fill(one.id, 's-a');
		await store.markDeleted(one.id, 5);
		const { row: two } = await store.intend(script, 6);
		await store.fill(two.id, 's-a');
	});

	it('lists the live rows of one account', async () => {
		const store = ledger();
		await store.intend(intent('A', SITE), 1);
		await store.intend(intent('A', OTHER_SITE), 1);
		expect(await store.account(ACCOUNT)).toHaveLength(2);
		expect(await store.account('b'.repeat(32))).toEqual([]);
	});
});

describe('assertOwned', () => {
	it('lets a live row of this site and account authorize a change', () => {
		expect(assertOwned('self-managed', ref(), [row()])).toMatchObject({ id: 'res_1' });
		expect(assertOwned('self-managed', ref({ action: 'update' }), [row()])).not.toBeNull();
	});

	it('refuses an id with no row, a row of another site or account, a deleted row and another kind', async () => {
		const cases: [Partial<OwnedRef>, Partial<LedgerRow>][] = [
			[{ id: 'kv-9' }, {}],
			[{}, { siteId: OTHER_SITE }],
			[{}, { accountId: 'b'.repeat(32) }],
			[{}, { deletedAt: 5 }],
			[{ kind: 'r2' }, {}]
		];
		for (const [over, rowOver] of cases) {
			const error = await trip(() => assertOwned('self-managed', ref(over), [row(rowOver)]));
			expect(error).toBeInstanceOf(NotOwnedError);
		}
	});

	it('does not let an intent authorize a delete or an update', async () => {
		const intent = row({ providerId: null });
		for (const action of ['delete', 'update'] as const) {
			const error = await trip(() => assertOwned('self-managed', ref({ action }), [intent]));
			expect(error).toBeInstanceOf(NotOwnedError);
		}
	});

	it('lets a create through only on an intent that carries the name and this operation', async () => {
		const intent = row({ providerId: null, name: 'wanted' });
		const create = ref({ action: 'create', id: 'wanted', operationId: OP });
		expect(assertOwned('self-managed', create, [intent])).not.toBeNull();
		await trip(() => assertOwned('self-managed', { ...create, id: 'other' }, [intent]));
		const foreign = await trip(() =>
			assertOwned('self-managed', { ...create, operationId: 'op_other' }, [intent])
		);
		expect(foreign).toBeInstanceOf(ForeignResourceError);
	});

	it('refuses to change a row the account no longer has', async () => {
		const error = await trip(() => assertOwned('self-managed', ref(), [row({ missingAt: 9 })]));
		expect(error).toBeInstanceOf(ResourceMissingError);
	});

	it('gives a managed site its own script name without a row, and nothing else', async () => {
		const script = (id: string) => ref({ kind: 'script', id, action: 'delete' });
		expect(assertOwned('managed', script(scriptName(SITE)), [])).toBeNull();
		expect(
			assertOwned('managed', { ...script(scriptName(SITE)), action: 'create' }, [])
		).toBeNull();
		await trip(() => assertOwned('managed', script(scriptName(OTHER_SITE)), []));
		await trip(() => assertOwned('self-managed', script(scriptName(SITE)), []));
		await trip(() => assertOwned('managed', ref(), []));
	});
});

describe('create, rollback, delete, purge and the sweep on a customer account', () => {
	for (const plane of ['self-managed', 'managed'] as const) {
		it(`leave the customer's own things byte for byte unchanged on a ${plane} site`, async () => {
			const world = await selfWorld({ plane });
			const before = world.cf.deep();
			await start(world);
			expect(await run(world)).toEqual({ status: 'succeeded' });
			expectKept(before, world.cf.deep());
			expect(world.cf.snapshot().kv).toHaveLength(6);
			expect(await remove(world)).toEqual({ status: 'succeeded' });
			expectKept(before, world.cf.deep());
			expect(await purge(world)).toEqual({ status: 'succeeded' });
			expect(world.cf.deep()).toBe(before);
		});
	}

	for (const when of ['before', 'after'] as const) {
		it(`a create that fails ${when} any step puts the account back as it found it`, async () => {
			for (const step of FORWARD) {
				const world = await selfWorld();
				const before = world.cf.deep();
				await start(world);
				await run(world, new Map(), { failAt: { step, when } });
				expectBack(before, world.cf.deep());
			}
		});
	}

	it('a sweep changes nothing and deletes nothing', async () => {
		const world = await selfWorld();
		await start(world);
		await run(world);
		const before = world.cf.deep();
		const deletes = world.cf.counts.delete;
		await sweepLeaks(world.cf.cloudflare, world.ledger, {
			accountId: ACCOUNT,
			plane: 'self-managed'
		});
		expect(world.cf.deep()).toBe(before);
		expect(world.cf.counts.delete).toBe(deletes);
	});

	it('switching a site to the canonical config deletes its own buckets and no other', async () => {
		const world = await selfWorld();
		await start(world);
		await run(world);
		const before = world.cf.deep();
		const buckets = (await world.ledger.live(world.siteId)).filter((r) => r.kind === 'r2');
		expect(buckets).toHaveLength(2);
		for (const bucket of buckets) {
			await ownedDelete(world.deps, 'self-managed', {
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'r2',
				id: bucket.providerId!
			});
			await world.ledger.markDeleted(bucket.id, 1);
		}
		const after = JSON.parse(world.cf.deep()) as Deep;
		expect(after.r2).toEqual(['customer-assets', ...lookAlikes(OTHER_SITE).r2].sort());
		expectKept(
			JSON.stringify({ ...(JSON.parse(before) as Deep), r2: after.r2 }),
			world.cf.deep()
		);
	});
});

describe('a name that looks like ours', () => {
	it('is refused as a KV namespace, with nothing created and nothing deleted', async () => {
		const world = await selfWorld({}, lookAlikes(SITE));
		const before = world.cf.deep();
		await start(world);
		const outcome = await run(world);
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('foreign_resource');
		expect(world.cf.deep()).toBe(before);
		expect(world.cf.counts.create).toBe(0);
		expect(world.cf.counts.delete).toBe(0);
		expect(await world.ledger.live(world.siteId)).toEqual([]);
	});

	it('is refused as a bucket after the earlier resources, which roll back by their own ids', async () => {
		const world = await selfWorld({}, { r2: [resourceName(SITE, 'files')] });
		const before = world.cf.deep();
		await start(world);
		const outcome = await run(world);
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('resource.FILES: foreign_resource');
		expect(world.cf.counts.create).toBe(2);
		expect(world.cf.counts.delete).toBe(2);
		expect(world.cf.deep()).toBe(before);
	});

	for (const plane of ['self-managed', 'managed'] as const) {
		it(`is refused as a script on a ${plane} site before any asset is uploaded`, async () => {
			const world = await selfWorld({ plane }, { script: scriptName(SITE) });
			const before = world.cf.deep();
			await start(world);
			const outcome = await run(world);
			expect(outcome.status).toBe('rolled-back');
			if (outcome.status !== 'rolled-back') return;
			expect(outcome.reason).toContain('assets.session: foreign_resource');
			expect(world.cf.counts.session).toBe(0);
			expect(world.cf.counts.putScript).toBe(0);
			expect(world.cf.deep()).toBe(before);
		});
	}

	it('is refused by claimResource with the typed error and leaves no row', async () => {
		const world = await selfWorld({}, { kv: [resourceName(SITE, 'config')] });
		const error = await trip(() =>
			claimResource(world.deps, claimOf(world), {
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config')
			})
		);
		expect(error).toBeInstanceOf(ForeignResourceError);
		expect((error as ForeignResourceError).reason).toBe('no_intent');
		expect(await world.ledger.live(world.siteId)).toEqual([]);
	});

	it('is refused when the only intent on file belongs to another operation', async () => {
		const world = await selfWorld();
		await world.ledger.intend(
			{
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config'),
				operationId: 'op_other'
			},
			1
		);
		const error = await trip(() =>
			claimResource(world.deps, claimOf(world), {
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config')
			})
		);
		expect((error as ForeignResourceError).reason).toBe('other_operation');
		expect(world.cf.counts.create).toBe(0);
	});
});

describe('a crash between a create and saving its id', () => {
	it('recovers through the intent row for a bucket, creating nothing twice', async () => {
		const world = await selfWorld();
		await start(world);
		const memo: Memo = new Map();
		const fill = world.deps.ledger.fill.bind(world.deps.ledger);
		let fills = 0;
		world.deps.ledger.fill = async (id, providerId, fingerprint) => {
			if (++fills === 3) throw new Killed(0);
			return fill(id, providerId, fingerprint);
		};
		await expect(run(world, memo)).rejects.toBeInstanceOf(Killed);
		const rows = await world.ledger.live(world.siteId);
		expect(rows.map((r) => [r.binding, r.providerId !== null])).toEqual([
			['CONFIG_KV', true],
			['PAGE_KV', true],
			['FILES', false]
		]);
		expect(await run(world, memo)).toEqual({ status: 'succeeded' });
		expect(world.cf.counts.create).toBe(4);
		const reference = await selfWorld();
		await start(reference);
		await run(reference);
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(reference));
	});

	it('recovers a script put whose row was never filled', async () => {
		const world = await selfWorld();
		await start(world);
		const memo: Memo = new Map();
		const fill = world.deps.ledger.fill.bind(world.deps.ledger);
		let fills = 0;
		world.deps.ledger.fill = async (id, providerId, fingerprint) => {
			if (++fills === 5) throw new Killed(0);
			return fill(id, providerId, fingerprint);
		};
		await expect(run(world, memo)).rejects.toBeInstanceOf(Killed);
		const script = (await world.ledger.live(world.siteId)).find((r) => r.kind === 'script');
		expect(script?.providerId).toBeNull();
		expect(world.cf.snapshot().scripts.some((s) => s.startsWith(scriptName(SITE)))).toBe(true);
		expect(await run(world, memo)).toEqual({ status: 'succeeded' });
		const filled = (await world.ledger.live(world.siteId)).find((r) => r.kind === 'script');
		expect(filled?.providerId).toBe(scriptName(SITE));
	});

	it('rolls back an intent whose resource was never created without deleting anything', async () => {
		const world = await selfWorld();
		const before = world.cf.deep();
		await world.ledger.intend(
			{
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config'),
				operationId: world.operationId
			},
			1
		);
		await start(world);
		const outcome = await run(world, new Map(), {
			failAt: { step: 'reserve-name', when: 'after' }
		});
		expect(outcome.status).toBe('rolled-back');
		expect(await world.ledger.live(world.siteId)).toEqual([]);
		expect(world.cf.counts.delete).toBe(0);
		expect(world.cf.deep()).toBe(before);
	});

	it('does not touch a record, or the resource it names, that another operation left behind', async () => {
		const world = await selfWorld({}, { kv: [resourceName(SITE, 'config')] });
		const before = world.cf.deep();
		await world.ledger.intend(
			{
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config'),
				operationId: 'op_other'
			},
			1
		);
		await start(world);
		await run(world, new Map(), { failAt: { step: 'reserve-name', when: 'after' } });
		expect(world.cf.deep()).toBe(before);
		expect(world.cf.counts.delete).toBe(0);
	});
});

describe('a purge', () => {
	it('given an id that is not in the ledger does nothing and raises a typed error', async () => {
		const world = await selfWorld();
		const lookAlike = (await world.cf.cloudflare.listResources('kv')).find(
			(item) => item.name === 'customer-sessions'
		)!;
		const before = world.cf.deep();
		const deletes = world.cf.counts.delete;
		const error = await trip(() =>
			ownedDelete(world.deps, 'self-managed', {
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				id: lookAlike.id
			})
		);
		expect(error).toBeInstanceOf(NotOwnedError);
		expect(world.cf.deep()).toBe(before);
		expect(world.cf.counts.delete).toBe(deletes);
	});

	it('refuses an id that another site of the same account owns', async () => {
		const world = await selfWorld();
		const { row: other } = await world.ledger.intend(
			{
				siteId: OTHER_SITE,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: 'theirs',
				operationId: OP
			},
			1
		);
		const made = await world.cf.cloudflare.createResource('kv', 'theirs');
		await world.ledger.fill(other.id, made.providerId);
		const before = world.cf.deep();
		await trip(() =>
			ownedDelete(world.deps, 'self-managed', {
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				id: made.providerId
			})
		);
		expect(world.cf.deep()).toBe(before);
	});

	it('refuses to delete a row that only holds an intent', async () => {
		const world = await selfWorld();
		await world.ledger.intend(
			{
				siteId: world.siteId,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: resourceName(SITE, 'config'),
				operationId: OP
			},
			1
		);
		const error = await trip(() =>
			purgeRows(
				world.deps,
				{ siteId: world.siteId, accountId: ACCOUNT, plane: 'self-managed' },
				['kv']
			)
		);
		expect(error.code).toBe('intent_unresolved');
		expect(world.cf.counts.delete).toBe(0);
	});

	async function tombstone(world: World) {
		const now = world.clock.now();
		await world.store.activateSite(
			{
				id: world.siteId,
				organizationId: world.orgId,
				name: 'Quiet Otter',
				plane: world.input.site.plane,
				accountId: ACCOUNT,
				category: 'cms',
				config: 'managed'
			},
			now
		);
		await world.store.setSiteState(world.siteId, 'tombstoned', now);
	}

	it('leaves a same-named script alone on a self-managed site that never recorded one', async () => {
		const world = await selfWorld({}, { script: scriptName(SITE) });
		await tombstone(world);
		const before = world.cf.deep();
		expect(await purge(world)).toEqual({ status: 'succeeded' });
		expect(world.cf.deep()).toBe(before);
	});

	it('refuses a same-named script of someone else on a managed site and deletes nothing', async () => {
		const world = await selfWorld({ plane: 'managed' }, { script: scriptName(SITE) });
		await tombstone(world);
		const before = world.cf.deep();
		const outcome = await purge(world);
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('script_changed');
		expect(world.cf.deep()).toBe(before);
	});
});

describe('routes on a customer zone', () => {
	async function created(hostname: string, plane: SitePlane = 'self-managed') {
		const world = await selfWorld({ plane, zoneId: 'zone-1' });
		world.input.hostname = hostname;
		const before = world.cf.deep();
		await start(world);
		return { world, before };
	}

	it('attaches a route it created, records it and removes it on purge', async () => {
		const { world, before } = await created('app.customer.com');
		expect(await run(world)).toEqual({ status: 'succeeded' });
		const route = (await world.ledger.live(world.siteId)).find((r) => r.kind === 'route');
		expect(route?.name).toBe('app.customer.com/*');
		expect(route?.providerId).toMatch(/^zone-1:route-/);
		expect(world.cf.snapshot().routes.filter((r) => r.includes(scriptName(SITE)))).toHaveLength(
			1
		);
		await remove(world);
		expect(await purge(world)).toEqual({ status: 'succeeded' });
		expect(world.cf.deep()).toBe(before);
	});

	it('removes only its own route when the create rolls back', async () => {
		const { world, before } = await created('app.customer.com');
		const outcome = await run(world, new Map(), { failAt: { step: 'verify', when: 'before' } });
		expect(outcome.status).toBe('rolled-back');
		expect(world.cf.deep()).toBe(before);
	});

	it('refuses a host that a wildcard route of another script covers', async () => {
		const { world, before } = await created('a.shop.customer.com');
		const outcome = await run(world);
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('route_shadow');
		expect(world.cf.deep()).toBe(before);
	});

	it('refuses the exact host of another script', async () => {
		const { world, before } = await created('www.customer.com');
		const outcome = await run(world);
		if (outcome.status !== 'rolled-back') throw new Error('expected a rollback');
		expect(outcome.reason).toContain('route_shadow');
		expect(world.cf.deep()).toBe(before);
	});

	it('writes no host entry when the route is refused', async () => {
		const { world } = await created('www.customer.com');
		let writes = 0;
		const putHost = world.deps.authority.putHost.bind(world.deps.authority);
		world.deps.authority.putHost = async (host, route) => {
			writes++;
			return putHost(host, route);
		};
		await run(world);
		expect(writes).toBe(0);
	});

	it('refuses a wildcard host', async () => {
		const error = await trip(() => checkRoute('*.customer.com', scriptName(SITE), []));
		expect(error.code).toBe('route_wildcard');
		await trip(() => checkRoute('app.customer.com/api', scriptName(SITE), []));
	});

	it('refuses a pattern that shares a host and a path prefix with another script', async () => {
		const other = { id: 'r', zoneId: 'z', script: 'theirs' };
		for (const pattern of [
			'app.customer.com/api/*',
			'app.customer.com/*',
			'*.customer.com/*'
		]) {
			const error = await trip(() =>
				checkRoute('app.customer.com', scriptName(SITE), [{ ...other, pattern }])
			);
			expect(error).toBeInstanceOf(RouteShadowError);
		}
	});

	it('does not mind routes on other hosts or its own script', () => {
		const route = (pattern: string, script: string | null) => ({
			id: 'r',
			zoneId: 'z',
			pattern,
			script
		});
		expect(() =>
			checkRoute('app.customer.com', scriptName(SITE), [
				route('other.customer.com/*', 'theirs'),
				route('app.customer.com/*', scriptName(SITE)),
				route('*.elsewhere.com/*', null)
			])
		).not.toThrow();
	});

	it('refuses an identical route of our script name that the ledger never recorded', async () => {
		const world = await selfWorld();
		await world.cf.cloudflare.addRoute('zone-2', 'app.customer.com/*', scriptName(SITE));
		const error = await trip(() =>
			attachRoute(world.deps, claimOf(world), {
				zoneId: 'zone-2',
				hostname: 'app.customer.com'
			})
		);
		expect(error).toBeInstanceOf(ForeignResourceError);
	});
});

describe('quota and rate limits', () => {
	const rate = (remaining: number | null, resetSeconds: number | null = 120) => ({
		remaining,
		resetSeconds,
		quota: 1200,
		windowSeconds: 300
	});

	async function reference() {
		const world = await selfWorld();
		await start(world);
		await run(world);
		return world;
	}

	it('stops a create the rate window cannot hold before it changes anything', async () => {
		const world = await selfWorld();
		world.cf.usage.rate = rate(2);
		const before = world.cf.deep();
		await start(world);
		const outcome = await run(world, new Map(), { retries: 2 });
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('rate_limited');
		expect(world.cf.counts.create).toBe(0);
		expect(world.cf.deep()).toBe(before);
		expect(await world.ledger.live(world.siteId)).toEqual([]);
	});

	it('retries the step and finishes in the state an unhindered run reaches', async () => {
		const world = await selfWorld();
		world.cf.usage.queue.push(rate(1), rate(1000));
		await start(world);
		expect(await run(world, new Map(), { retries: 1 })).toEqual({ status: 'succeeded' });
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(await reference()));
	});

	it('stops a create that would pass the namespace limit and creates nothing', async () => {
		const world = await selfWorld();
		world.deps.config.account = { kvNamespaces: 3 };
		const before = world.cf.deep();
		await start(world);
		const outcome = await run(world, new Map(), { retries: 1 });
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('quota_exhausted');
		expect(world.cf.counts.create).toBe(0);
		expect(world.cf.deep()).toBe(before);
	});

	it('lets a later operation create the site once the namespace limit is lifted', async () => {
		const world = await selfWorld();
		world.deps.config.account = { kvNamespaces: 3 };
		await start(world);
		expect((await run(world)).status).toBe('rolled-back');
		world.deps.config.account = { kvNamespaces: 1000 };
		world.operationId = `op_${'q'.repeat(26)}`;
		world.input.operationId = world.operationId;
		await beginCreate(world, 'create-2');
		expect(await run(world)).toEqual({ status: 'succeeded' });
		expect(world.cf.snapshot().kv).toHaveLength(6);
		expect(await world.ledger.live(world.siteId)).toHaveLength(5);
	});

	it('rolls back by recorded id when a rate limit hits mid-create and retries run out', async () => {
		const world = await selfWorld();
		const before = world.cf.deep();
		world.cf.hooks.beforeCreate = (kind) => {
			if (kind === 'r2') throw new RateLimitedError('slow down', 5000);
		};
		await start(world);
		const outcome = await run(world, new Map(), { retries: 2 });
		expect(outcome.status).toBe('rolled-back');
		expect(world.cf.counts.create).toBe(2);
		expect(world.cf.deep()).toBe(before);
	});

	it('keeps the intent after a mid-create limit and finishes on the retry', async () => {
		const world = await selfWorld();
		let thrown = false;
		world.cf.hooks.beforeCreate = (kind) => {
			if (kind === 'r2' && !thrown) {
				thrown = true;
				throw new RateLimitedError('slow down', 5000);
			}
		};
		await start(world);
		expect(await run(world, new Map(), { retries: 1 })).toEqual({ status: 'succeeded' });
		expect(world.cf.counts.create).toBe(4);
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(await reference()));
	});

	it('does not treat a rate limit as a permanent refusal', () => {
		expect(new RateLimitedError('x', 1)).not.toBeInstanceOf(PermanentError);
	});
});

describe('drift', () => {
	async function made(plane: SitePlane = 'self-managed') {
		const world = await selfWorld({ plane });
		await start(world);
		await run(world);
		return world;
	}

	it('marks a resource that is gone from the account as missing and reports it', async () => {
		const world = await made();
		const page = (await world.ledger.live(world.siteId)).find((r) => r.binding === 'PAGE_KV')!;
		await world.cf.cloudflare.deleteResource('kv', page.providerId!);
		const before = world.cf.deep();
		const report = await reconcileSite(world.deps, world.siteId);
		expect(report.missing.map((r) => r.binding)).toEqual(['PAGE_KV']);
		expect(report.changed).toEqual([]);
		const state = (await world.ledger.live(world.siteId)).find((r) => r.binding === 'PAGE_KV');
		expect(stateOf(state!)).toBe('missing');
		expect(world.cf.deep()).toBe(before);
	});

	it('reports a script and a route that vanished', async () => {
		const world = await selfWorld({ zoneId: 'zone-1' });
		world.input.hostname = 'app.customer.com';
		await start(world);
		await run(world);
		await world.cf.cloudflare.deleteScript(scriptName(SITE));
		for (const route of await world.cf.cloudflare.listRoutes('zone-1')) {
			if (route.script === scriptName(SITE))
				await world.cf.cloudflare.removeRoute('zone-1', route.id);
		}
		const report = await reconcileSite(world.deps, world.siteId);
		expect(report.missing.map((r) => r.kind).sort()).toEqual(['route', 'script']);
	});

	it('never recreates a missing resource on a self-managed site', async () => {
		const world = await made();
		const config = (await world.ledger.live(world.siteId)).find(
			(r) => r.binding === 'CONFIG_KV'
		)!;
		await world.cf.cloudflare.deleteResource('kv', config.providerId!);
		await reconcileSite(world.deps, world.siteId);
		const creates = world.cf.counts.create;
		const error = await trip(() =>
			claimResource(world.deps, claimOf(world), {
				kind: 'kv',
				binding: 'CONFIG_KV',
				name: config.name
			})
		);
		expect(error).toBeInstanceOf(ResourceMissingError);
		expect(world.cf.counts.create).toBe(creates);
	});

	it('may recreate a missing resource on a managed site, with a new row', async () => {
		const world = await made('managed');
		const config = (await world.ledger.live(world.siteId)).find(
			(r) => r.binding === 'CONFIG_KV'
		)!;
		await world.cf.cloudflare.deleteResource('kv', config.providerId!);
		await reconcileSite(world.deps, world.siteId);
		const again = await claimResource(world.deps, claimOf(world), {
			kind: 'kv',
			binding: 'CONFIG_KV',
			name: config.name
		});
		expect(again.providerId).not.toBe(config.providerId);
		expect(world.cf.snapshot().kv.map(([, title]) => title)).toContain(config.name);
		const rows = await world.ledger.all(world.siteId);
		expect(rows.filter((r) => r.binding === 'CONFIG_KV').map(stateOf)).toEqual([
			'deleted',
			'live'
		]);
	});

	it('reports a script whose tag changed and will not overwrite or delete it', async () => {
		const world = await made();
		const name = scriptName(SITE);
		world.cf.tamper(name, { tags: ['team:web'] });
		const report = await reconcileSite(world.deps, world.siteId);
		expect(report.changed.map((c) => c.why)).toEqual(['tag']);
		const before = world.cf.deep();
		const error = await trip(() =>
			claimScript(world.deps, claimOf(world, { operationId: OP }))
		);
		expect(error).toBeInstanceOf(ScriptChangedError);
		const deleted = await trip(() =>
			ownedDelete(world.deps, 'self-managed', {
				siteId: SITE,
				accountId: ACCOUNT,
				kind: 'script',
				id: name
			})
		);
		expect(deleted).toBeInstanceOf(ScriptChangedError);
		expect(world.cf.deep()).toBe(before);
	});

	it('reports a script whose version changed, and overwrites only when told to', async () => {
		const world = await made();
		world.cf.tamper(scriptName(SITE), {});
		const report = await reconcileSite(world.deps, world.siteId);
		expect(report.changed.map((c) => c.why)).toEqual(['version']);
		const error = await trip(() => claimScript(world.deps, claimOf(world)));
		expect((error as ScriptChangedError).why).toBe('version');
		await claimScript(world.deps, claimOf(world), { overwriteChanged: true });
	});

	it('finds nothing when nothing changed', async () => {
		const world = await made();
		expect(await reconcileSite(world.deps, world.siteId)).toEqual({ missing: [], changed: [] });
	});
});

describe('the leak sweep', () => {
	it('reports our-looking resources with no row and nothing else, on a self-managed account', async () => {
		const world = await selfWorld();
		await start(world);
		await run(world);
		const before = world.cf.deep();
		const report = await sweepLeaks(world.cf.cloudflare, world.ledger, {
			accountId: ACCOUNT,
			plane: 'self-managed'
		});
		const names = report.leaks.map((leak) => leak.name).sort();
		const expected = [
			...lookAlikes(OTHER_SITE).kv,
			...lookAlikes(OTHER_SITE).r2,
			...lookAlikes(OTHER_SITE).d1
		].sort();
		expect(names).toEqual(expected);
		expect(report.proposedDeletes).toEqual([]);
		expect(world.cf.deep()).toBe(before);
	});

	it('proposes the same list on a managed account and still deletes nothing', async () => {
		const world = await selfWorld({ plane: 'managed' });
		const deletes = world.cf.counts.delete;
		const report = await sweepLeaks(world.cf.cloudflare, world.ledger, {
			accountId: ACCOUNT,
			plane: 'managed'
		});
		expect(report.leaks).toHaveLength(5);
		expect(report.proposedDeletes).toEqual(report.leaks);
		expect(world.cf.counts.delete).toBe(deletes);
	});

	it('does not call a resource a leak while its intent is on file, and lists the intent as pending', async () => {
		const world = await selfWorld({}, {});
		const name = resourceName(SITE, 'config');
		await world.ledger.intend(
			{
				siteId: SITE,
				accountId: ACCOUNT,
				kind: 'kv',
				binding: 'CONFIG_KV',
				name,
				operationId: OP
			},
			1
		);
		await world.cf.cloudflare.createResource('kv', name);
		const report = await sweepLeaks(world.cf.cloudflare, world.ledger, {
			accountId: ACCOUNT,
			plane: 'self-managed'
		});
		expect(report.leaks).toEqual([]);
		expect(report.pending).toEqual([{ siteId: SITE, kind: 'kv', name }]);
	});

	it('only needs the read methods', async () => {
		const world = await selfWorld();
		const report = await sweepLeaks(
			{ listResources: world.cf.cloudflare.listResources },
			{ account: (id) => world.ledger.account(id) },
			{ accountId: ACCOUNT, plane: 'self-managed' }
		);
		expect(report.leaks).toHaveLength(5);
	});
});

describe('adopting a script by name', () => {
	it('is allowed only for a script that carries this site tag', async () => {
		const world = await selfWorld();
		await world.ledger.intend(
			{
				siteId: SITE,
				accountId: ACCOUNT,
				kind: 'script',
				binding: 'SCRIPT',
				name: scriptName(SITE),
				operationId: world.operationId
			},
			1
		);
		world.cf.seedCustomer({ script: scriptName(SITE) });
		const error = await trip(() => claimScript(world.deps, claimOf(world)));
		expect(error).toBeInstanceOf(ForeignResourceError);
	});
});

describe('every typed refusal', () => {
	it('was tripped once', () => {
		expect([...tripped].sort()).toEqual([...OWNERSHIP_ERROR_CODES].sort());
	});
});
