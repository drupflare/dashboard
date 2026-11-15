import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { pitrWorkerOf } from '../../../engine/src/adapters/pitr';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { PitrDeps, PitrWorker } from '../../../engine/src/ports';
import {
	planSitePitr,
	runSitePitr,
	type SitePitrInput
} from '../../../engine/src/workflows/site-pitr';
import { fakeBlobs, fakeKv, fakeWorkers } from './backup-fakes';
import {
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	type Memo,
	type RunnerScript
} from './fakes';

const HOST = 'quiet-otter.drupflare.app';
const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
const UNDO = '0000007c-0000b26e-00001538-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fakePitr(options: { refuse?: string } = {}) {
	const calls = { at: [] as number[], schedule: [] as string[], bearers: new Set<string>() };
	const worker: PitrWorker = {
		async bookmarkAt(host, at, auth) {
			expect(host).toBe(HOST);
			calls.bearers.add(auth.bearer);
			calls.at.push(at);
			return BOOKMARK;
		},
		async schedule(host, bookmark, auth) {
			expect(host).toBe(HOST);
			calls.bearers.add(auth.bearer);
			if (options.refuse !== undefined) throw new Error(options.refuse);
			calls.schedule.push(bookmark);
			return { scheduled: bookmark, undo: UNDO };
		}
	};
	return { worker, calls };
}

async function pitrWorld(options: { token?: boolean; refuse?: string } = {}) {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const now = world.clock.now();
	await world.store.activateSite(
		{
			id: world.siteId,
			organizationId: world.orgId,
			name: 'Quiet Otter',
			plane: 'managed',
			accountId: world.accountId,
			category: 'cms',
			config: 'managed'
		},
		now
	);
	world.sqlite
		.prepare('UPDATE sites SET primary_hostname = ? WHERE id = ?')
		.run(HOST, world.siteId);
	if (options.token !== false) {
		await world.deps.custody.sealOwnerToken(world.siteId, FAKE_OWNER_TOKEN);
	}
	const log: string[] = [];
	const pitr = fakePitr({ refuse: options.refuse });
	const deps: PitrDeps = {
		...world.deps,
		worker: backupWorkerOf(fakeWorkers(log).fetcher, 1_000),
		blobs: fakeBlobs().blobs,
		backups: new D1BackupLedger(db),
		kv: fakeKv(log).kv,
		sleep: async () => undefined,
		pitr: pitr.worker
	};
	const at = now - 3 * 86_400_000;
	const input: SitePitrInput = {
		operationId: world.operationId,
		orgId: world.orgId,
		siteId: world.siteId,
		accountId: world.accountId,
		at
	};
	return { world, deps, pitr, input, at };
}

type Pw = Awaited<ReturnType<typeof pitrWorld>>;

async function run(pw: Pw, memo: Memo = new Map(), script: RunnerScript = {}) {
	const frozen = await freezePlan(planSitePitr(pw.input));
	if (memo.size === 0) {
		const operation = newOperation({
			id: pw.input.operationId,
			orgId: pw.world.orgId,
			idempotencyKey: 'pitr-1',
			frozen,
			verification: 'not-required',
			now: pw.world.clock.now()
		});
		await pw.world.store.begin({
			operation,
			accountId: pw.world.accountId,
			siteId: pw.world.siteId
		});
	}
	const { runner } = makeRunner(memo, script);
	return runSitePitr(runner, pw.deps, pw.input);
}

describe('point-in-time restore', () => {
	it('plans one site with unique steps and no undo point yet', async () => {
		const pw = await pitrWorld();
		const plan = planSitePitr(pw.input);
		expect(plan.type).toBe('site.restore');
		expect(plan.targetIds).toEqual([pw.world.siteId]);
		expect(plan.rollbackPoint).toBeNull();
		const ids = plan.steps.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(plan.preconditions.join(' ')).toContain(new Date(pw.at).toISOString());
	});

	it('schedules the restore for the chosen moment and stores the undo bookmark on the operation', async () => {
		const pw = await pitrWorld();

		const outcome = await run(pw);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(pw.pitr.calls.at).toEqual([pw.at]);
		expect(pw.pitr.calls.schedule).toEqual([BOOKMARK]);
		expect(pw.pitr.calls.bearers).toEqual(new Set([FAKE_OWNER_TOKEN]));
		const operation = (await pw.world.store.get(pw.input.operationId))!;
		expect(operation.rollbackPoint).toBe(UNDO);
		expect(operation.status).toBe('succeeded');
		expect(operation.finalObservation?.summary).toContain('the next time it starts');
		expect(operation.finalObservation?.summary).not.toContain(UNDO);
		expect(pw.world.leases.stateOf(pw.world.siteId).holder ?? null).toBeNull();
	});

	it('does not schedule a second time when a run dies after saving the undo point', async () => {
		const pw = await pitrWorld();
		const memo: Memo = new Map();
		// start, lease, check, bookmark, schedule: the fifth step dies before its result is kept
		await run(pw, memo, { killDuring: 5 }).then(
			() => expect.unreachable('the run should have been killed'),
			(error) => expect(error).toBeInstanceOf(Killed)
		);
		expect((await pw.world.store.get(pw.input.operationId))!.rollbackPoint).toBe(UNDO);

		expect(await run(pw, memo)).toEqual({ status: 'succeeded' });

		expect(pw.pitr.calls.schedule).toEqual([BOOKMARK]);
		expect((await pw.world.store.get(pw.input.operationId))!.rollbackPoint).toBe(UNDO);
	});

	it('fails without an owner token and schedules nothing', async () => {
		const pw = await pitrWorld({ token: false });
		const outcome = await run(pw);
		expect(outcome.status).toBe('failed');
		expect(outcome.status === 'failed' ? outcome.reason : '').toContain('no_owner_token');
		expect(pw.pitr.calls.schedule).toEqual([]);
		expect((await pw.world.store.get(pw.input.operationId))!.rollbackPoint).toBeNull();
	});

	it('fails when the site refuses to schedule and keeps no undo point', async () => {
		const pw = await pitrWorld({ refuse: 'refused by the site' });
		const outcome = await run(pw);
		expect(outcome.status).toBe('failed');
		expect((await pw.world.store.get(pw.input.operationId))!.rollbackPoint).toBeNull();
	});
});

describe('the site answers', () => {
	const NOW = Date.UTC(2026, 10, 14);
	const reply = (status: number, body: unknown) =>
		(async () => Response.json(body, { status })) as unknown as typeof fetch;
	const auth = { bearer: FAKE_OWNER_TOKEN };

	it('reads the bookmark for a moment from the owner route', async () => {
		const seen: string[] = [];
		const fetcher = (async (url: URL, init: RequestInit) => {
			seen.push(`${init.method} ${url.pathname}${url.search}`);
			expect((init.headers as Record<string, string>).authorization).toBe(
				`Bearer ${FAKE_OWNER_TOKEN}`
			);
			return Response.json({ ok: true, at: 'x', bookmark: BOOKMARK });
		}) as unknown as typeof fetch;
		const worker = pitrWorkerOf(fetcher, 1_000);
		expect(await worker.bookmarkAt(HOST, NOW, auth)).toBe(BOOKMARK);
		expect(seen).toEqual([`GET /pitr?at=${NOW}`]);
	});

	it('schedules with a POST and returns the undo bookmark', async () => {
		const seen: string[] = [];
		const fetcher = (async (url: URL, init: RequestInit) => {
			seen.push(`${init.method} ${url.pathname}${url.search}`);
			return Response.json({ ok: true, scheduled: BOOKMARK, undo: UNDO, note: 'x' });
		}) as unknown as typeof fetch;
		const worker = pitrWorkerOf(fetcher, 1_000);
		expect(await worker.schedule(HOST, BOOKMARK, auth)).toEqual({
			scheduled: BOOKMARK,
			undo: UNDO
		});
		expect(seen).toEqual([`POST /pitr?bookmark=${BOOKMARK}`]);
	});

	it.each([
		[501, { ok: false, supported: false }, 'pitr_unsupported'],
		[400, { error: 'outside the 30-day recovery window' }, 'pitr_refused'],
		[401, {}, 'owner_token_rejected']
	])('refuses permanently on %s', async (status, body, code) => {
		const worker = pitrWorkerOf(reply(status, body), 1_000);
		await expect(worker.bookmarkAt(HOST, NOW, auth)).rejects.toMatchObject({ code });
		await expect(worker.schedule(HOST, BOOKMARK, auth)).rejects.toMatchObject({ code });
	});

	it('lets a server error retry and refuses a schedule answer with no undo point', async () => {
		await expect(
			pitrWorkerOf(reply(503, {}), 1_000).schedule(HOST, BOOKMARK, auth)
		).rejects.toThrow('answered 503');
		await expect(
			pitrWorkerOf(reply(200, { ok: true, scheduled: BOOKMARK }), 1_000).schedule(
				HOST,
				BOOKMARK,
				auth
			)
		).rejects.toMatchObject({ code: 'pitr_no_undo' });
		await expect(
			pitrWorkerOf(reply(200, { ok: true }), 1_000).bookmarkAt(HOST, NOW, auth)
		).rejects.toMatchObject({ code: 'pitr_unreadable' });
	});
});
