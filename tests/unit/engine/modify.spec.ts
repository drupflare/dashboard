import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { D1EditLedger, modifyWorkerOf } from '../../../engine/src/adapters/modify';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import {
	buildEditBundle,
	editBundleBytes,
	editKeys,
	parseEditBundle,
	revisionOf
} from '../../../engine/src/modify-bundle';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { EditLedger, ModifyDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import {
	editRowId,
	planModifyApply,
	runModifyApply,
	type ModifyApplyInput
} from '../../../engine/src/workflows/modify-apply';
import { blobRequestBytes, MODIFY_MAX_REQUEST_BYTES } from '../../../src/shared/modify';
import { dumpOf, fakeBlobs, fakeWorkers } from './backup-fakes';
import { FAKE_OWNER_TOKEN, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';
import { fakeModify } from './modify-fakes';

const BACKUP_ID = `bkp_${'e'.repeat(26)}`;
const PACKAGE = 'my_module';
const ROOT = `modules/custom/${PACKAGE}`;

const files = (version = 1) => [
	{
		path: `${ROOT}/${PACKAGE}.info.yml`,
		source: `name: Mine\ntype: module\n`,
		bytes: 24
	},
	{
		path: `${ROOT}/${PACKAGE}.module`,
		source: `<?php\n// v${version}\n`,
		bytes: 15
	}
];

async function modifyWorld(options: { token?: boolean; ledger?: EditLedger } = {}) {
	const world = await makeWorld();
	const log: string[] = [];
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const worker = fakeWorkers(log);
	const blobs = fakeBlobs();
	const now = world.clock.now();
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, account_id,
			release_id, created_at, updated_at) VALUES (?, ?, 'Site', 'managed', 'active', ?, ?, 'rel-1', ?, ?)`
		)
		.run(world.siteId, world.orgId, world.input.hostname, world.accountId, now, now);
	if (options.token !== false) {
		await world.deps.custody.sealOwnerToken(world.siteId, FAKE_OWNER_TOKEN);
	}
	worker.add(world.input.hostname, world.siteId, { sql: dumpOf(30), aligned: true });
	const fake = fakeModify();
	const deps: ModifyDeps = {
		...world.deps,
		worker: backupWorkerOf(worker.fetcher, 1_000),
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		sleep: async () => undefined,
		modify: fake.worker,
		edits: options.ledger ?? new D1EditLedger(db)
	};
	return { world, deps, blobs, fake };
}

type Mw = Awaited<ReturnType<typeof modifyWorld>>;

async function store(mw: Mw, version = 1, operationId = mw.world.operationId) {
	const bundle = await buildEditBundle(PACKAGE, files(version));
	const key = editKeys.bundle(mw.world.orgId, mw.world.siteId, operationId);
	await mw.blobs.blobs.put(key, editBundleBytes(bundle));
	return { bundle, key, rev: await revisionOf(bundle) };
}

const inputOf = (mw: Mw, bundleKey: string, note = 'Fix the header'): ModifyApplyInput => ({
	operationId: mw.world.operationId,
	orgId: mw.world.orgId,
	siteId: mw.world.siteId,
	accountId: mw.world.accountId,
	backupId: BACKUP_ID,
	name: PACKAGE,
	bundleKey,
	note
});

async function run(
	mw: Mw,
	input: ModifyApplyInput,
	options: { memo?: Memo; script?: RunnerScript } = {}
) {
	if (options.memo === undefined || options.memo.size === 0) {
		const operation = newOperation({
			id: mw.world.operationId,
			orgId: mw.world.orgId,
			idempotencyKey: 'edit-1',
			frozen: await freezePlan(planModifyApply(input)),
			now: mw.world.clock.now()
		});
		await mw.world.store.begin({
			operation,
			accountId: mw.world.accountId,
			siteId: mw.world.siteId
		});
	}
	const { runner } = makeRunner(options.memo ?? new Map(), options.script);
	return runModifyApply(runner, mw.deps, input);
}

const operationOf = async (mw: Mw) => (await mw.world.store.get(mw.world.operationId))!;
const restorePoint = (mw: Mw) => mw.deps.backups.get(mw.world.orgId, BACKUP_ID);
const rows = (mw: Mw) =>
	mw.world.sqlite.prepare('SELECT * FROM site_revisions ORDER BY created_at').all() as Record<
		string,
		unknown
	>[];
const reasonOf = (outcome: { status: string; reason?: string }) => outcome.reason ?? '';

describe('the plan', () => {
	it('names the restore point as the rollback point and keeps step ids unique', async () => {
		const mw = await modifyWorld();
		const plan = planModifyApply(inputOf(mw, 'k'));
		const ids = plan.steps.map((step) => step.id);
		expect(plan.type).toBe('modify.apply');
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			'lease',
			'preflight',
			'export',
			'restore-point-verify',
			'restore-point-record',
			'deliver',
			'verify',
			'record'
		]);
		expect(plan.rollbackPoint).toBe(BACKUP_ID);
	});
});

describe('an edit', () => {
	it('takes a restore point, sends the files once, checks the site and records the row', async () => {
		const mw = await modifyWorld();
		const { key, rev } = await store(mw);
		let pointBefore = false;
		mw.fake.script.afterStore = () => void (pointBefore = true);
		const outcome = await run(mw, inputOf(mw, key));
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(pointBefore).toBe(true);
		expect(await restorePoint(mw)).toMatchObject({ siteId: mw.world.siteId });
		expect(mw.fake.calls.delivers).toHaveLength(1);
		expect(mw.fake.calls.delivers[0]).toMatchObject({ name: PACKAGE, label: 'Fix the header' });
		expect(mw.fake.active.get(PACKAGE)).toBe(rev);
		const operation = await operationOf(mw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(rows(mw)).toEqual([
			expect.objectContaining({
				id: editRowId(mw.world.operationId),
				kind: 'edit',
				release_id: 'rel-1',
				bundle_key: key,
				note: 'Fix the header'
			})
		]);
		expect(mw.world.leases.stateOf(mw.world.siteId).holder ?? null).toBeNull();
	});

	it('uses the owner token the site holds for every call', async () => {
		const mw = await modifyWorld();
		await run(mw, inputOf(mw, (await store(mw)).key));
		expect([...mw.fake.calls.bearers]).toEqual([FAKE_OWNER_TOKEN]);
	});

	it('sends nothing again when a lost answer left the revision running', async () => {
		const mw = await modifyWorld();
		const { key } = await store(mw);
		let lost = true;
		mw.fake.script.afterStore = () => {
			if (!lost) return;
			lost = false;
			throw new Error('the answer was lost');
		};
		const outcome = await run(mw, inputOf(mw, key), { script: { retries: 1 } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.delivers).toHaveLength(1);
		expect(rows(mw)).toHaveLength(1);
	});

	it('stops cleanly when the site refuses the commit and leaves the earlier files running', async () => {
		const mw = await modifyWorld();
		mw.fake.active.set(PACKAGE, 'prior-rev');
		mw.fake.script.deliver = 'refuse';
		mw.fake.script.refusal = 'a transaction is open';
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('a transaction is open');
		expect(reasonOf(outcome)).toContain('left as it was');
		expect(mw.fake.active.get(PACKAGE)).toBe('prior-rev');
		expect(mw.fake.calls.activates).toEqual([]);
		expect(rows(mw)).toEqual([]);
		expect(await restorePoint(mw)).not.toBeNull();
		const operation = await operationOf(mw);
		expect(operation.status).toBe('failed');
		expect(operation.verification).toBe('failed');
		expect(mw.world.leases.stateOf(mw.world.siteId).holder ?? null).toBeNull();
	});

	it('puts the earlier revision back when the site fails its check afterward', async () => {
		const mw = await modifyWorld();
		mw.fake.active.set(PACKAGE, 'prior-rev');
		mw.world.site.answers.probe = 500;
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('answered 500');
		expect(reasonOf(outcome)).toContain('earlier files are back');
		expect(mw.fake.active.get(PACKAGE)).toBe('prior-rev');
		expect(mw.fake.calls.activates).toEqual(['prior-rev']);
		expect(rows(mw)).toEqual([]);
	});

	it('says so when a first delivery fails its check and there is nothing to put back', async () => {
		const mw = await modifyWorld();
		mw.world.site.answers.probe = 500;
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(reasonOf(outcome)).toContain('no earlier revision to put back');
		expect(reasonOf(outcome)).toContain(BACKUP_ID);
		expect(mw.fake.calls.activates).toEqual([]);
	});

	it('points to the restore point when the earlier revision will not come back', async () => {
		const mw = await modifyWorld();
		mw.fake.active.set(PACKAGE, 'prior-rev');
		mw.fake.script.activateOk = false;
		mw.world.site.answers.probe = 500;
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(reasonOf(outcome)).toContain('may still be on the site');
		expect(reasonOf(outcome)).toContain(BACKUP_ID);
	});

	it('reports the unknown state when the site cannot be read after a failure', async () => {
		const mw = await modifyWorld();
		const { key } = await store(mw);
		mw.fake.script.deliver = 'wrong-rev';
		const read = mw.fake.worker.active;
		let reads = 0;
		mw.fake.worker.active = async (host, name, auth) => {
			// the preflight and the send read once each; every later read fails
			if (++reads > 2) throw new Error('the site is gone');
			return read(host, name, auth);
		};
		const outcome = await run(mw, inputOf(mw, key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('different revision');
		expect(reasonOf(outcome)).toContain('may be on the site');
	});

	it('refuses a revision the site reports differently than the one sent', async () => {
		const mw = await modifyWorld();
		mw.fake.script.deliver = 'wrong-rev';
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('different revision');
	});

	it('says the edit is missing from the history when the row cannot be written', async () => {
		const mw = await modifyWorld({
			ledger: {
				async record() {
					throw new PermanentError('ledger_down', 'the history store refused');
				}
			}
		});
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('missing from the code history');
		expect(mw.fake.calls.activates).toEqual([]);
	});

	it('changes nothing when the stored files are gone', async () => {
		const mw = await modifyWorld();
		const outcome = await run(
			mw,
			inputOf(mw, editKeys.bundle(mw.world.orgId, mw.world.siteId, 'op_missing_000'))
		);
		expect(reasonOf(outcome)).toContain('The stored files are gone.');
		expect(reasonOf(outcome)).toContain('nothing on the site was changed');
		expect(mw.fake.calls.delivers).toEqual([]);
		expect(await restorePoint(mw)).toBeNull();
	});

	it('refuses a bundle that lives under another site', async () => {
		const mw = await modifyWorld();
		const foreign = editKeys.bundle(mw.world.orgId, 'site_other0000', 'op_other_000');
		await mw.blobs.blobs.put(foreign, editBundleBytes(await buildEditBundle(PACKAGE, files())));
		const outcome = await run(mw, inputOf(mw, foreign));
		expect(reasonOf(outcome)).toContain('belong to another site');
		expect(mw.fake.calls.delivers).toEqual([]);
	});

	it('refuses a bundle for another package and one that no longer matches its hashes', async () => {
		const mw = await modifyWorld();
		const key = editKeys.bundle(mw.world.orgId, mw.world.siteId, mw.world.operationId);
		await mw.blobs.blobs.put(
			key,
			editBundleBytes(await buildEditBundle('other_module', files()))
		);
		expect(reasonOf(await run(mw, inputOf(mw, key)))).toContain('belong to another package');

		const damaged = await modifyWorld();
		const bundle = await buildEditBundle(PACKAGE, files());
		bundle.files[0]!.source = 'changed';
		await damaged.blobs.blobs.put(key, editBundleBytes(bundle));
		expect(reasonOf(await run(damaged, inputOf(damaged, key)))).toContain(
			'does not match its hash'
		);
		expect(damaged.fake.calls.delivers).toEqual([]);
	});

	it('refuses a file the site could not take in one request', async () => {
		const mw = await modifyWorld();
		const source = 'x'.repeat(MODIFY_MAX_REQUEST_BYTES);
		const key = editKeys.bundle(mw.world.orgId, mw.world.siteId, mw.world.operationId);
		const big = await buildEditBundle(PACKAGE, [
			{ path: `${ROOT}/big.txt`, source, bytes: source.length }
		]);
		await mw.blobs.blobs.put(key, editBundleBytes(big));
		const outcome = await run(mw, inputOf(mw, key));
		expect(reasonOf(outcome)).toContain('too large');
		expect(mw.fake.calls.delivers).toEqual([]);
	});

	it('refuses a site the dashboard holds no owner token for', async () => {
		const mw = await modifyWorld({ token: false });
		const outcome = await run(mw, inputOf(mw, (await store(mw)).key));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('no owner token');
		expect(mw.fake.calls.delivers).toEqual([]);
	});

	it('goes back to an earlier edit by naming its bundle, and records one row per operation', async () => {
		const mw = await modifyWorld();
		const first = await store(mw, 1, 'op_first_00001');
		mw.fake.active.set(PACKAGE, 'later-rev');
		const outcome = await run(mw, inputOf(mw, first.key, 'Rolled back to: first'));
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.active.get(PACKAGE)).toBe(first.rev);
		expect(rows(mw)).toEqual([
			expect.objectContaining({ bundle_key: first.key, note: 'Rolled back to: first' })
		]);
		const ledger = new D1EditLedger((mw.world.ledger as unknown as { db: D1Database }).db);
		await ledger.record({
			id: editRowId(mw.world.operationId),
			organizationId: mw.world.orgId,
			siteId: mw.world.siteId,
			bundleKey: first.key,
			note: 'again',
			now: 1
		});
		expect(rows(mw)).toHaveLength(1);
	});
});

describe('the edit bundle', () => {
	it('reads back what was written and names the revision the way the site does', async () => {
		const bundle = await buildEditBundle(PACKAGE, files());
		const read = await parseEditBundle(editBundleBytes(bundle));
		expect(read).toEqual(bundle);
		expect(await revisionOf(read)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses bytes that are not a bundle', async () => {
		await expect(parseEditBundle(new TextEncoder().encode('nope'))).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
		await expect(parseEditBundle(new TextEncoder().encode('{"v":2}'))).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
	});

	it('refuses a key part that is not an id', () => {
		expect(() => editKeys.bundle('org/../x', 'site_a', 'op_a')).toThrow(PermanentError);
	});
});

// #region the adapter against a fake site

type Held = { want: Set<string>; blobs: Map<string, string>; active: string | null };

function fakeSiteFetch(options: { status?: number; body?: unknown } = {}) {
	const seen: { url: URL; init: RequestInit; body: unknown }[] = [];
	const held: Held = { want: new Set(), blobs: new Map(), active: null };
	const fetcher = (async (input: URL | string, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
		seen.push({ url, init, body });
		if (options.status !== undefined) {
			return new Response(
				typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
				{ status: options.status }
			);
		}
		const action = url.searchParams.get('action');
		const reply = (status: number, value: unknown) =>
			new Response(JSON.stringify(value), { status });
		if (action === 'revisions')
			return reply(200, { ok: true, revisions: [], active: held.active });
		if (action === 'plan') {
			const declared = (body as { files: { hash: string }[] }).files;
			return reply(200, {
				ok: true,
				want: declared.map((file) => file.hash).filter((hash) => !held.blobs.has(hash))
			});
		}
		if (action === 'blobs') {
			for (const blob of (body as { blobs: { hash: string; source: string }[] }).blobs) {
				held.blobs.set(blob.hash, blob.source);
			}
			return reply(200, { ok: true });
		}
		if (action === 'commit') {
			held.active = 'rev-committed';
			return reply(200, { ok: true, rev: 'rev-committed' });
		}
		if (action === 'activate') return reply(200, { ok: true });
		return reply(400, { error: 'unknown action' });
	}) as unknown as typeof fetch;
	return { fetcher, seen, held };
}

const AUTH = { bearer: 'tok' };
const HOST = 'www.example.edu';

const hashed = (n: number, source: string) => ({
	path: `${ROOT}/f${n}.txt`,
	source,
	hash: String(n).padStart(64, '0'),
	bytes: source.length
});

describe('the modify adapter', () => {
	it('plans, sends only the blobs the site lacks, then commits', async () => {
		const site = fakeSiteFetch();
		const worker = modifyWorkerOf(site.fetcher, 1_000);
		const set = [hashed(1, 'one'), hashed(2, 'two')];
		site.held.blobs.set(set[0]!.hash, 'one');
		const answer = await worker.deliver(
			HOST,
			{ name: PACKAGE, label: 'note', files: set },
			AUTH
		);
		expect(answer).toEqual({ kind: 'applied', rev: 'rev-committed' });
		const actions = site.seen.map((call) => call.url.searchParams.get('action'));
		expect(actions).toEqual(['plan', 'blobs', 'commit']);
		expect(site.seen[1]!.body).toEqual({ blobs: [{ hash: set[1]!.hash, source: 'two' }] });
		const commit = site.seen[2]!;
		expect(commit.url.searchParams.get('package')).toBe(PACKAGE);
		expect(commit.url.searchParams.get('label')).toBe('note');
		expect(commit.url.searchParams.get('origin')).toBe('dashboard');
		expect(commit.body).toEqual({
			files: set.map(({ path, hash }) => ({ path, hash }))
		});
		expect(new Headers(commit.init.headers).get('authorization')).toBe('Bearer tok');
	});

	it('sends a second delivery of the same set without a blobs call', async () => {
		const site = fakeSiteFetch();
		const worker = modifyWorkerOf(site.fetcher, 1_000);
		const set = [hashed(1, 'one')];
		await worker.deliver(HOST, { name: PACKAGE, label: 'a', files: set }, AUTH);
		site.seen.length = 0;
		await worker.deliver(HOST, { name: PACKAGE, label: 'a', files: set }, AUTH);
		expect(site.seen.map((call) => call.url.searchParams.get('action'))).toEqual([
			'plan',
			'commit'
		]);
	});

	it('splits blobs across requests so none passes the ceiling', async () => {
		const site = fakeSiteFetch();
		const worker = modifyWorkerOf(site.fetcher, 1_000);
		const big = 'y'.repeat(1_200_000);
		const set = [hashed(1, big), hashed(2, big), hashed(3, 'small')];
		await worker.deliver(HOST, { name: PACKAGE, label: 'a', files: set }, AUTH);
		const sends = site.seen.filter((call) => call.url.searchParams.get('action') === 'blobs');
		expect(sends.length).toBeGreaterThan(1);
		for (const call of sends) {
			expect(String(call.init.body).length).toBeLessThanOrEqual(MODIFY_MAX_REQUEST_BYTES);
		}
		expect(blobRequestBytes(big)).toBeGreaterThan(1_200_000);
		expect(site.held.blobs.size).toBe(3);
	});

	it('answers refused with the sites own reason, bounded and without control characters', async () => {
		const site = fakeSiteFetch();
		const original = site.fetcher;
		const worker = modifyWorkerOf(
			(async (input: URL | string, init?: RequestInit) =>
				new URL(String(input)).searchParams.get('action') === 'commit'
					? new Response(
							JSON.stringify({
								ok: false,
								error: `rolled back:\n${'z'.repeat(400)}`
							}),
							{
								status: 409
							}
						)
					: original(input, init)) as typeof fetch,
			1_000
		);
		const answer = await worker.deliver(
			HOST,
			{ name: PACKAGE, label: 'a', files: [hashed(1, 'one')] },
			AUTH
		);
		expect(answer.kind).toBe('refused');
		const reason = (answer as { reason: string }).reason;
		expect(reason).toHaveLength(300);
		expect(reason).not.toContain('\n');
	});

	it('names a refusal when the site answers without a reason', async () => {
		const worker = modifyWorkerOf(fakeSiteFetch({ status: 422, body: {} }).fetcher, 1_000);
		const answer = await worker.deliver(
			HOST,
			{ name: PACKAGE, label: 'a', files: [hashed(1, 'one')] },
			AUTH
		);
		expect(answer).toEqual({ kind: 'refused', reason: 'The site refused the file list.' });
	});

	it('refuses to take a commit answer that carries no revision', async () => {
		const original = fakeSiteFetch().fetcher;
		const worker = modifyWorkerOf(
			(async (input: URL | string, init?: RequestInit) =>
				new URL(String(input)).searchParams.get('action') === 'commit'
					? new Response(JSON.stringify({ ok: true }))
					: original(input, init)) as typeof fetch,
			1_000
		);
		await expect(
			worker.deliver(HOST, { name: PACKAGE, label: 'a', files: [hashed(1, 'one')] }, AUTH)
		).rejects.toThrow('no readable answer to the commit');
	});

	it('stops a blob batch the site did not take', async () => {
		const original = fakeSiteFetch().fetcher;
		const worker = modifyWorkerOf(
			(async (input: URL | string, init?: RequestInit) =>
				new URL(String(input)).searchParams.get('action') === 'blobs'
					? new Response(JSON.stringify({ ok: false }), { status: 422 })
					: original(input, init)) as typeof fetch,
			1_000
		);
		const answer = await worker.deliver(
			HOST,
			{ name: PACKAGE, label: 'a', files: [hashed(1, 'one')] },
			AUTH
		);
		expect(answer).toEqual({ kind: 'refused', reason: 'The site did not take every file.' });
	});

	it('reads the active revision and null for a package with none', async () => {
		const site = fakeSiteFetch();
		const worker = modifyWorkerOf(site.fetcher, 1_000);
		expect(await worker.active(HOST, PACKAGE, AUTH)).toBeNull();
		site.held.active = 'abc';
		expect(await worker.active(HOST, PACKAGE, AUTH)).toBe('abc');
		expect(site.seen[0]!.init.method).toBe('GET');
	});

	it('activates a stored revision and reports a refusal', async () => {
		const worker = modifyWorkerOf(fakeSiteFetch().fetcher, 1_000);
		expect(await worker.activate(HOST, PACKAGE, 'abc', AUTH)).toEqual({ ok: true });
		const refused = modifyWorkerOf(fakeSiteFetch({ status: 404 + 5, body: {} }).fetcher, 1_000);
		expect(await refused.activate(HOST, PACKAGE, 'abc', AUTH)).toEqual({ ok: false });
	});

	it.each([
		[401, 'owner_token_rejected'],
		[403, 'owner_token_rejected'],
		[404, 'modify_unavailable']
	])('answers %s with a permanent %s', async (status, code) => {
		const worker = modifyWorkerOf(fakeSiteFetch({ status, body: {} }).fetcher, 1_000);
		await expect(worker.active(HOST, PACKAGE, AUTH)).rejects.toMatchObject({ code });
	});

	it('retries a site error and a site that asks for the call again', async () => {
		const broken = modifyWorkerOf(fakeSiteFetch({ status: 503, body: {} }).fetcher, 1_000);
		await expect(broken.active(HOST, PACKAGE, AUTH)).rejects.not.toBeInstanceOf(PermanentError);
		const again = modifyWorkerOf(
			fakeSiteFetch({ status: 200, body: { retry: true } }).fetcher,
			1_000
		);
		await expect(again.active(HOST, PACKAGE, AUTH)).rejects.toThrow('asked for the call again');
	});

	it('refuses a listing answer it cannot read and one the site refused', async () => {
		const unreadable = modifyWorkerOf(
			fakeSiteFetch({ status: 200, body: { active: 5 } }).fetcher,
			1_000
		);
		await expect(unreadable.active(HOST, PACKAGE, AUTH)).rejects.toThrow('no readable');
		const refused = modifyWorkerOf(
			fakeSiteFetch({ status: 400, body: { error: 'package is required' } }).fetcher,
			1_000
		);
		await expect(refused.active(HOST, PACKAGE, AUTH)).rejects.toMatchObject({
			code: 'modify_refused'
		});
	});
});

// #endregion
