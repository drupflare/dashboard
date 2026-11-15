import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { D1ConfigLedger } from '../../../engine/src/adapters/config-changes';
import { settingsWorkerOf } from '../../../engine/src/adapters/settings';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { ConfigDeps, SettingLever, SettingsWorker } from '../../../engine/src/ports';
import {
	planConfigApply,
	refuseKey,
	revertChanges,
	runConfigApply,
	type ConfigApplyInput
} from '../../../engine/src/workflows/config-apply';
import { fakeBlobs, fakeKv, fakeWorkers } from './backup-fakes';
import { FAKE_OWNER_TOKEN, Killed, makeRunner, makeWorld, type Memo } from './fakes';

const HOST = 'quiet-otter.drupflare.app';

const DOMAINS = {
	WARM_INTERVAL_MS: {
		kind: 'int',
		min: 8000,
		max: 600000,
		unit: 'ms',
		default: 8000
	},
	SPOOL: { kind: 'flag' },
	CSP_MODE: { kind: 'enum', values: ['off', 'report-only', 'enforce'] },
	REPLICA_AUTOSCALE: { kind: 'flag' }
} as const satisfies Record<string, SettingLever['domain']>;

interface FakeOptions {
	// accepts a write and keeps nothing, so the read back differs
	dropWrites?: boolean;
	// the site names a value it will not take
	invalid?: boolean;
	// runs on every read, to change the site between two calls
	onRead?: (store: Map<string, string>) => void;
}

function fakeSite(options: FakeOptions = {}) {
	const store = new Map<string, string>();
	const calls = {
		reads: 0,
		writes: [] as Record<string, unknown>[],
		ifMatch: [] as (string | null)[]
	};
	const levers = (): SettingLever[] =>
		Object.entries(DOMAINS).map(([name, domain]) => ({
			name,
			value: store.get(name) ?? null,
			source: store.has(name) ? 'kv' : 'default',
			domain
		}));
	const worker: SettingsWorker = {
		async read(host, auth) {
			expect(host).toBe(HOST);
			expect(auth.bearer).toBe(FAKE_OWNER_TOKEN);
			calls.reads++;
			options.onRead?.(store);
			return levers();
		},
		async write(host, patch, auth, ifMatch) {
			expect(host).toBe(HOST);
			expect(auth.bearer).toBe(FAKE_OWNER_TOKEN);
			calls.writes.push(patch);
			calls.ifMatch.push(ifMatch);
			if (options.invalid) {
				return {
					refused: [],
					invalid: [{ name: Object.keys(patch)[0]!, reason: 'out of range' }]
				};
			}
			if (!options.dropWrites) {
				for (const [name, value] of Object.entries(patch)) {
					if (value === null) store.delete(name);
					else store.set(name, String(value).trim());
				}
			}
			return { refused: [], invalid: [] };
		}
	};
	return { worker, store, calls };
}

async function configWorld(options: FakeOptions & { token?: boolean } = {}) {
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
	const site = fakeSite(options);
	const changes = new D1ConfigLedger(db);
	const deps: ConfigDeps = {
		...world.deps,
		worker: backupWorkerOf(fakeWorkers(log).fetcher, 1_000),
		blobs: fakeBlobs().blobs,
		backups: new D1BackupLedger(db),
		kv: fakeKv(log).kv,
		sleep: async () => undefined,
		settings: site.worker,
		changes
	};
	const input = (over: Partial<ConfigApplyInput> = {}): ConfigApplyInput => ({
		operationId: world.operationId,
		orgId: world.orgId,
		siteId: world.siteId,
		accountId: world.accountId,
		actor: 'user:u1',
		owner: false,
		changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }],
		expected: { WARM_INTERVAL_MS: null },
		...over
	});
	return { world, deps, site, changes, input };
}

type Cw = Awaited<ReturnType<typeof configWorld>>;

const begun = new WeakSet<object>();

async function begin(cw: Cw, input: ConfigApplyInput): Promise<void> {
	const frozen = await freezePlan(planConfigApply(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: cw.world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		verification: 'pending',
		now: cw.world.clock.now()
	});
	await cw.world.store.begin({
		operation,
		accountId: cw.world.accountId,
		siteId: cw.world.siteId
	});
}

async function run(cw: Cw, input: ConfigApplyInput, memo: Memo = new Map(), kill?: number) {
	if (!begun.has(memo)) {
		await begin(cw, input);
		begun.add(memo);
	}
	const { runner } = makeRunner(memo, kill === undefined ? {} : { killDuring: kill });
	return runConfigApply(runner, cw.deps, input);
}

const rowsOf = (cw: Cw, operationId = cw.world.operationId) =>
	cw.changes.forOperation(cw.world.orgId, operationId);

const reasonOf = (outcome: Awaited<ReturnType<typeof run>>) =>
	outcome.status === 'failed' || outcome.status === 'cancelled' ? outcome.reason : '';

describe('config apply plan', () => {
	it('plans one site with unique steps and a count of settings', async () => {
		const cw = await configWorld();
		const plan = planConfigApply(cw.input());
		expect(plan.type).toBe('config.apply');
		expect(plan.targetIds).toEqual([cw.world.siteId]);
		expect(plan.preconditions.join(' ')).toContain('1 setting to change');
		const ids = plan.steps.map((step) => step.id);
		expect(ids).toEqual(['lease', 'check', 'write', 'verify', 'record']);
	});
});

describe('config apply', () => {
	it('applies a valid change, reads it back and records before and after', async () => {
		const cw = await configWorld();

		const outcome = await run(cw, cw.input());

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(cw.site.calls.writes).toEqual([{ WARM_INTERVAL_MS: 30000 }]);
		expect(cw.site.store.get('WARM_INTERVAL_MS')).toBe('30000');
		const [row] = await rowsOf(cw);
		expect(row).toMatchObject({
			key: 'WARM_INTERVAL_MS',
			status: 'applied',
			actor: 'user:u1',
			revertedBy: null,
			after: '30000'
		});
		expect(JSON.parse(row!.before)).toEqual({ value: null, source: 'default' });
		const operation = (await cw.world.store.get(cw.world.operationId))!;
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.rollbackPoint).toBe(`settings:${cw.world.operationId}`);
		expect(cw.world.leases.stateOf(cw.world.siteId).holder ?? null).toBeNull();
	});

	it('sends the etag it was given as If-Match', async () => {
		const cw = await configWorld();
		await run(cw, cw.input({ ifMatch: '"abc"' }));
		expect(cw.site.calls.ifMatch).toEqual(['"abc"']);
	});

	it('clears an override when the value is null', async () => {
		const cw = await configWorld();
		cw.site.store.set('WARM_INTERVAL_MS', '20000');

		const outcome = await run(
			cw,
			cw.input({
				changes: [{ key: 'WARM_INTERVAL_MS', value: null }],
				expected: { WARM_INTERVAL_MS: 20000 }
			})
		);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(cw.site.store.has('WARM_INTERVAL_MS')).toBe(false);
		expect(cw.site.calls.writes).toEqual([{ WARM_INTERVAL_MS: null }]);
	});

	it('conflicts on a stale read and writes nothing', async () => {
		const cw = await configWorld();
		cw.site.store.set('WARM_INTERVAL_MS', '12000');

		const outcome = await run(cw, cw.input());

		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('settings_changed');
		expect(cw.site.calls.writes).toEqual([]);
		expect(await rowsOf(cw)).toEqual([]);
	});

	it('refuses the plan, in either case, with no write', async () => {
		for (const key of ['PLAN', 'plan']) {
			const cw = await configWorld();
			const outcome = await run(cw, cw.input({ changes: [{ key, value: 'paid' }] }));
			expect(outcome.status).toBe('failed');
			expect(reasonOf(outcome)).toContain('plan_not_writable');
			expect(cw.site.calls.writes).toEqual([]);
			expect(cw.site.calls.reads).toBe(0);
		}
	});

	it('refuses a setting the site cannot override with no write', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({ changes: [{ key: 'REPLICA_AUTOSCALE', value: '1' }] })
		);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('not_overridable');
		expect(cw.site.calls.writes).toEqual([]);
		expect(await rowsOf(cw)).toEqual([]);
	});

	it('refuses an owner-only setting for a caller who is not an owner', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({
				owner: false,
				changes: [{ key: 'CSP_MODE', value: 'enforce' }],
				expected: { CSP_MODE: null }
			})
		);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('owner_only');
		expect(cw.site.calls.writes).toEqual([]);
	});

	it('allows an owner-only setting for an owner', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({
				owner: true,
				changes: [{ key: 'CSP_MODE', value: 'enforce' }],
				expected: { CSP_MODE: null }
			})
		);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(cw.site.store.get('CSP_MODE')).toBe('enforce');
	});

	it('compares a secret by its digest and keeps no plaintext in a history row or the operation', async () => {
		const { SITE_CONFIG_REGISTRY } = await import('../../../src/shared/site-config/registry');
		const { KV_OVERRIDABLE_NAMES } = await import('../../../src/shared/site-config/registry');
		const { secretDigest } = await import('../../../src/shared/site-config/secrets');
		const names = KV_OVERRIDABLE_NAMES as unknown as string[];
		const domains = DOMAINS as unknown as Record<string, SettingLever['domain']>;
		SITE_CONFIG_REGISTRY['SECRET_X'] = {
			label: 'Secret',
			layer: 'kv',
			permission: 'runtime',
			domain: { kind: 'text' },
			widget: 'secret'
		};
		names.push('SECRET_X');
		domains['SECRET_X'] = { kind: 'enum', values: ['old-plaintext', 'new-plaintext'] };
		try {
			const cw = await configWorld();
			cw.site.store.set('SECRET_X', 'old-plaintext');
			const stale = await run(
				cw,
				cw.input({
					changes: [{ key: 'SECRET_X', value: 'new-plaintext' }],
					expected: { SECRET_X: await secretDigest('wrong') }
				})
			);
			expect(reasonOf(stale)).toContain('settings_changed');
			expect(cw.site.calls.writes).toEqual([]);

			const cw2 = await configWorld();
			cw2.site.store.set('SECRET_X', 'old-plaintext');
			const outcome = await run(
				cw2,
				cw2.input({
					changes: [{ key: 'SECRET_X', value: 'new-plaintext' }],
					expected: { SECRET_X: await secretDigest('old-plaintext') }
				})
			);
			expect(outcome).toEqual({ status: 'succeeded' });
			expect(cw2.site.store.get('SECRET_X')).toBe('new-plaintext');
			const [row] = await rowsOf(cw2);
			expect(JSON.parse(row!.before)).toEqual({ value: 'Set', source: 'kv' });
			expect(row!.after).toBe('"Set"');
			const operation = await cw2.world.store.get(cw2.world.operationId);
			const stored = JSON.stringify([row, operation]);
			expect(stored).not.toContain('old-plaintext');
			expect(stored).not.toContain('new-plaintext');
		} finally {
			delete SITE_CONFIG_REGISTRY['SECRET_X'];
			delete domains['SECRET_X'];
			names.splice(names.indexOf('SECRET_X'), 1);
		}
	});

	it('writes nothing when one value fails the schema', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({
				changes: [
					{ key: 'WARM_INTERVAL_MS', value: 30000 },
					{ key: 'SPOOL', value: '2' }
				],
				expected: { WARM_INTERVAL_MS: null, SPOOL: null },
				owner: true
			})
		);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('setting_invalid');
		expect(reasonOf(outcome)).toContain('SPOOL');
		expect(cw.site.calls.writes).toEqual([]);
		expect(await rowsOf(cw)).toEqual([]);
	});

	it('refuses a value below the site minimum', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({ changes: [{ key: 'WARM_INTERVAL_MS', value: 5 }] })
		);
		expect(reasonOf(outcome)).toContain('setting_invalid');
		expect(cw.site.calls.writes).toEqual([]);
	});

	it('refuses a setting the site does not list', async () => {
		const cw = await configWorld();
		const outcome = await run(
			cw,
			cw.input({ changes: [{ key: 'SITE_WARM', value: '0' }], expected: { SITE_WARM: null } })
		);
		expect(reasonOf(outcome)).toContain('not a setting this site exposes');
		expect(cw.site.calls.writes).toEqual([]);
	});

	it('stops when the values are already in force', async () => {
		const cw = await configWorld();
		cw.site.store.set('WARM_INTERVAL_MS', '30000');
		const outcome = await run(cw, cw.input({ expected: { WARM_INTERVAL_MS: 30000 } }));
		expect(reasonOf(outcome)).toContain('nothing_to_change');
		expect(cw.site.calls.writes).toEqual([]);
	});

	it('marks the row unconfirmed and fails when the site does not report the value back', async () => {
		const cw = await configWorld({ dropWrites: true });

		const outcome = await run(cw, cw.input());

		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('verify_failed');
		const [row] = await rowsOf(cw);
		expect(row?.status).toBe('unverified');
		const operation = (await cw.world.store.get(cw.world.operationId))!;
		expect(operation.verification).toBe('failed');
		expect(operation.status).toBe('failed');
	});

	it('marks the row as not applied when the site refuses the value', async () => {
		const cw = await configWorld({ invalid: true });
		const outcome = await run(cw, cw.input());
		expect(reasonOf(outcome)).toContain('setting_invalid');
		const [row] = await rowsOf(cw);
		expect(row?.status).toBe('failed');
	});

	it('fails without an owner token and sends nothing', async () => {
		const cw = await configWorld({ token: false });
		const outcome = await run(cw, cw.input());
		expect(reasonOf(outcome)).toContain('no_owner_token');
		expect(cw.site.calls.writes).toEqual([]);
	});

	it('writes once whichever step a run dies in, then finishes on the next run', async () => {
		// start, lease, check, write, verify, record, release-lease, finalize
		for (let kill = 1; kill <= 8; kill++) {
			const cw = await configWorld();
			const memo: Memo = new Map();
			const input = cw.input();
			await run(cw, input, memo, kill).then(
				() => expect.unreachable(`step ${kill} should have been killed`),
				(error) => expect(error).toBeInstanceOf(Killed)
			);

			expect(await run(cw, input, memo)).toEqual({ status: 'succeeded' });

			expect(cw.site.calls.writes, `killed in step ${kill}`).toEqual([
				{ WARM_INTERVAL_MS: 30000 }
			]);
			expect((await rowsOf(cw)).map((row) => row.status)).toEqual(['applied']);
		}
	});

	it('does not read the settings again when the history rows already hold the first reading', async () => {
		const cw = await configWorld();
		const memo: Memo = new Map();
		const input = cw.input();
		// the check step dies after its rows landed, before its result is kept
		await run(cw, input, memo, 3).catch(() => undefined);
		const before = (await rowsOf(cw))[0];
		// the site moves on, which a fresh check would call a conflict
		cw.site.store.set('WARM_INTERVAL_MS', '30000');

		expect(await run(cw, input, memo)).toEqual({ status: 'succeeded' });

		expect((await rowsOf(cw))[0]?.before).toBe(before?.before);
	});

	it('reverts to the values the change replaced, an override only when there was one', async () => {
		const cw = await configWorld();
		cw.site.store.set('WARM_INTERVAL_MS', '20000');
		cw.site.store.set('SPOOL', '1');
		const first = cw.input({
			owner: true,
			changes: [
				{ key: 'WARM_INTERVAL_MS', value: 30000 },
				{ key: 'SPOOL', value: null }
			],
			expected: { WARM_INTERVAL_MS: 20000, SPOOL: '1' }
		});
		expect(await run(cw, first)).toEqual({ status: 'succeeded' });
		expect(cw.site.store.get('WARM_INTERVAL_MS')).toBe('30000');
		expect(cw.site.store.has('SPOOL')).toBe(false);

		const done = await rowsOf(cw);
		const undo = revertChanges(done);
		expect(undo).toEqual([
			{ key: 'SPOOL', value: '1' },
			{ key: 'WARM_INTERVAL_MS', value: 20000 }
		]);
		const second = cw.input({
			operationId: `op_${'q'.repeat(26)}`,
			owner: true,
			changes: undo,
			expected: { WARM_INTERVAL_MS: 30000, SPOOL: null },
			reverts: done.map((row) => row.id)
		});

		expect(await run(cw, second)).toEqual({ status: 'succeeded' });

		expect(cw.site.store.get('WARM_INTERVAL_MS')).toBe('20000');
		expect(cw.site.store.get('SPOOL')).toBe('1');
		expect((await rowsOf(cw)).every((row) => row.revertedBy === second.operationId)).toBe(true);
		expect((await rowsOf(cw, second.operationId)).map((row) => row.status)).toEqual([
			'applied',
			'applied'
		]);
	});

	it('reverts a setting that had no override by clearing it', () => {
		const rows = [
			{ key: 'WARM_INTERVAL_MS', before: JSON.stringify({ value: 8000, source: 'var' }) }
		];
		expect(revertChanges(rows)).toEqual([{ key: 'WARM_INTERVAL_MS', value: null }]);
	});
});

describe('refuseKey', () => {
	it('lets an ordinary setting through for anyone', () => {
		expect(refuseKey('WARM_INTERVAL_MS', false)).toBeNull();
	});

	it('names the code for each refusal', () => {
		expect(refuseKey('PLAN', true)?.code).toBe('plan_not_writable');
		expect(refuseKey('PAGE_KV_TTL', true)?.code).toBe('not_overridable');
		expect(refuseKey('SPOOL', false)?.code).toBe('owner_only');
		expect(refuseKey('SPOOL', true)).toBeNull();
	});
});

describe('the settings route of a site', () => {
	const auth = { bearer: FAKE_OWNER_TOKEN };
	const levers = Object.entries(DOMAINS).map(([name, domain]) => ({
		name,
		value: null,
		source: 'default',
		domain
	}));

	it('reads the levers with the owner token', async () => {
		const seen: string[] = [];
		const fetcher = (async (url: URL, init: RequestInit) => {
			seen.push(`${init.method} ${url.pathname}`);
			expect((init.headers as Record<string, string>).authorization).toBe(
				`Bearer ${FAKE_OWNER_TOKEN}`
			);
			return Response.json({ ok: true, plan: 'free', levers });
		}) as unknown as typeof fetch;
		const read = await settingsWorkerOf(fetcher, 1_000).read(HOST, auth);
		expect(read.map((lever) => lever.name)).toContain('WARM_INTERVAL_MS');
		expect(seen).toEqual(['GET /settings']);
	});

	it('writes with a PUT, a JSON body and the If-Match it was given', async () => {
		let sent: { method?: string; body?: string; headers?: Record<string, string> } = {};
		const fetcher = (async (_url: URL, init: RequestInit) => {
			sent = {
				method: init.method,
				body: String(init.body),
				headers: init.headers as Record<string, string>
			};
			return Response.json({ ok: true, refused: ['X'], invalid: [] });
		}) as unknown as typeof fetch;
		const worker = settingsWorkerOf(fetcher, 1_000);
		const answer = await worker.write(HOST, { SPOOL: '0' }, auth, '"tag"');
		expect(sent.method).toBe('PUT');
		expect(JSON.parse(sent.body!)).toEqual({ SPOOL: '0' });
		expect(sent.headers?.['if-match']).toBe('"tag"');
		expect(answer.refused).toEqual(['X']);
		await worker.write(HOST, { SPOOL: '0' }, auth, null);
		expect(sent.headers?.['if-match']).toBeUndefined();
	});

	it.each([
		[401, 'owner_token_rejected'],
		[412, 'settings_changed'],
		[501, 'settings_unsupported'],
		[400, 'settings_refused']
	])('maps a %i answer to %s without retrying', async (status, code) => {
		const fetcher = (async () => new Response('{}', { status })) as unknown as typeof fetch;
		const worker = settingsWorkerOf(fetcher, 1_000);
		await expect(worker.write(HOST, { SPOOL: '0' }, auth, null)).rejects.toMatchObject({
			code
		});
		await expect(worker.read(HOST, auth)).rejects.toMatchObject({ code });
	});

	it('retries a 503 and refuses an answer it cannot read', async () => {
		const worker = settingsWorkerOf(
			(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
			1_000
		);
		await expect(worker.read(HOST, auth)).rejects.not.toHaveProperty('code');
		const garbled = settingsWorkerOf(
			(async () => Response.json({ nope: true })) as unknown as typeof fetch,
			1_000
		);
		await expect(garbled.read(HOST, auth)).rejects.toMatchObject({
			code: 'settings_unreadable'
		});
		await expect(garbled.write(HOST, {}, auth, null)).rejects.toMatchObject({
			code: 'settings_unreadable'
		});
	});
});
