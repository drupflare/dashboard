import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import { custodyOf } from '../../../engine/src/adapters/custody';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	OwnerTokenConflictError,
	collegeOwnerTokenStore,
	collegePendingSecretStore,
	revealOwnerToken,
	revealPendingSecret,
	rewrapOwnerToken,
	rewrapPendingSecret,
	rotateOwnerToken,
	storeOwnerToken,
	withOwnerToken,
	type CustodyDeps,
	type OwnerTokenStore,
	type PendingSecretDeps
} from '../../../src/server/services/owner-tokens';
import purgeTask, {
	PurgeFailedError,
	purgePendingSecrets
} from '../../../src/server/tasks/pending-secrets-purge';
import { loadKeyRing } from '../../../src/shared/custody/envelope';
import { PENDING_SECRET_SQL } from '../../../src/shared/custody/records';
import { openBindings, type Bindings, type OpenBindings } from '../support';

// the Nitro runtime needs a built server; the task is a plain object around defineTask
vi.mock('nitropack/runtime', () => ({ defineTask: (task: unknown) => task }));

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => open.close());

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
const user = { kind: 'user' as const, userId: 'user_1' };

async function custody(siteId: string, token = 'owner-token-0') {
	const deps: CustodyDeps = {
		store: collegeOwnerTokenStore(async () => db),
		audit: { append: async () => undefined },
		ring: await loadKeyRing({ KEK_V1: kek(1) })
	};
	await storeOwnerToken(deps, { siteId, actor: 'system', token });
	return deps;
}

// the first few readers all see the record before any of them writes, so the writes truly race
function readsTogether(store: OwnerTokenStore, parties: number): OwnerTokenStore {
	let arrived = 0;
	let release: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (release = resolve));
	return {
		put: (siteId, value, expected) => store.put(siteId, value, expected),
		async get(siteId) {
			const value = await store.get(siteId);
			if (arrived < parties) {
				if (++arrived === parties) release();
				await open;
			}
			return value;
		}
	};
}

async function row(siteId: string) {
	return env.DB.prepare('SELECT version, previous_envelope FROM owner_tokens WHERE site_id = ?')
		.bind(siteId)
		.first<{ version: number; previous_envelope: string | null }>();
}

describe('owner token store against real D1', () => {
	it('round-trips a record and counts versions from one', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		expect((await deps.store.get(siteId))?.version).toBe(1);
		expect(
			await withOwnerToken(deps, { siteId, actor: 'a', operation: 'o' }, async (t) => t)
		).toBe('owner-token-0');
		expect(await deps.store.get(`site_${crypto.randomUUID()}`)).toBeNull();
	});

	it('refuses a second first-write and a stale update with the typed conflict', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		const stored = (await deps.store.get(siteId))!;
		const record = { current: stored.current, previous: null };
		await expect(deps.store.put(siteId, record, null)).rejects.toBeInstanceOf(
			OwnerTokenConflictError
		);
		expect(await deps.store.put(siteId, record, 1)).toBe(2);
		await expect(deps.store.put(siteId, record, 1)).rejects.toBeInstanceOf(
			OwnerTokenConflictError
		);
		expect((await row(siteId))?.version).toBe(2);
	});

	it('lets exactly one of several parallel rotations win and keeps custody with the winner', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		let onSite = 'owner-token-0';
		const pushed: string[] = [];
		const push = async (next: string, old: string) => {
			if (old !== onSite) throw new Error('the site refused the old token');
			onSite = next;
			pushed.push(next);
		};
		const call = { siteId, principal: user, stepUp: true };
		const racing = { ...deps, store: readsTogether(deps.store, 5) };
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () => rotateOwnerToken(racing, call, push))
		);
		const won = results.filter((result) => result.status === 'fulfilled');
		const lost = results.filter((result): result is PromiseRejectedResult => {
			return result.status === 'rejected';
		});
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(4);
		for (const loss of lost) expect(loss.reason).toBeInstanceOf(OwnerTokenConflictError);
		expect(pushed).toHaveLength(1);
		expect(await revealOwnerToken(deps, { ...call, stepUp: true })).toBe(onSite);
		const after = await row(siteId);
		expect(after?.previous_envelope).toBeNull();
	});

	it('lets rotations that run one after another all succeed', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		let onSite = 'owner-token-0';
		const push = async (next: string, old: string) => {
			if (old !== onSite) throw new Error('the site refused the old token');
			onSite = next;
		};
		const call = { siteId, principal: user, stepUp: true };
		await rotateOwnerToken(deps, call, push);
		await rotateOwnerToken(deps, call, push);
		expect(await revealOwnerToken(deps, call)).toBe(onSite);
	});

	it('restores the old record when the push fails, and keeps the record readable', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		const call = { siteId, principal: user, stepUp: true };
		await expect(
			rotateOwnerToken(deps, call, async () => {
				throw new Error('worker unreachable');
			})
		).rejects.toThrow('worker unreachable');
		expect(await revealOwnerToken(deps, call)).toBe('owner-token-0');
		expect((await row(siteId))?.previous_envelope).toBeNull();
	});

	it('rewraps under a newer key version without losing the token', async () => {
		const siteId = `site_${crypto.randomUUID()}`;
		const deps = await custody(siteId);
		const grown: CustodyDeps = {
			...deps,
			ring: await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) })
		};
		expect(await rewrapOwnerToken(grown, { siteId, actor: 'system' })).toBe(true);
		expect((await grown.store.get(siteId))?.current.kv).toBe(2);
		expect(await revealOwnerToken(grown, { siteId, principal: user, stepUp: true })).toBe(
			'owner-token-0'
		);
	});
});

describe('what the engine seals in real D1, the dashboard reads', () => {
	const PASSWORD = 'minted-admin-password-0123456789';
	const now = () => Date.now();

	async function sealed() {
		const siteId = `site_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
		const orgId = `org_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
		await env.DB.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
			 VALUES (?, ?, 'Quiet Otter', 'managed', 'active', 1, 1)`
		)
			.bind(siteId, orgId)
			.run();
		const engine = custodyOf({
			db: env.DB,
			secrets: { KEK_V1: kek(1) },
			pendingTtlMs: 60_000,
			now
		});
		await engine.sealPendingSecret(siteId, 'admin-password', PASSWORD);
		await engine.sealOwnerToken(siteId, 'owner-token-0');
		return { siteId, orgId, engine };
	}

	async function pendingDeps(keys: Record<string, string> = { KEK_V1: kek(1) }) {
		const deps: PendingSecretDeps = {
			store: collegePendingSecretStore(async () => db),
			audit: { append: async () => undefined },
			ring: await loadKeyRing(keys),
			now
		};
		return deps;
	}

	const reveal = (deps: PendingSecretDeps, orgId: string, siteId: string) =>
		revealPendingSecret(deps, { orgId, siteId, kind: 'admin-password', principal: user });

	it('reveals the owner token through the dashboard store', async () => {
		const { siteId } = await sealed();
		const deps: CustodyDeps = {
			store: collegeOwnerTokenStore(async () => db),
			audit: { append: async () => undefined },
			ring: await loadKeyRing({ KEK_V1: kek(1) })
		};
		expect(await revealOwnerToken(deps, { siteId, principal: user, stepUp: true })).toBe(
			'owner-token-0'
		);
	});

	it('reveals the password once, and wipes the ciphertext', async () => {
		const { siteId, orgId } = await sealed();
		const deps = await pendingDeps();
		expect(await reveal(deps, orgId, siteId)).toBe(PASSWORD);
		await expect(reveal(deps, orgId, siteId)).rejects.toMatchObject({ code: 'not_found' });
		const row = await env.DB.prepare(
			'SELECT ciphertext, revealed_at FROM pending_secrets WHERE site_id = ?'
		)
			.bind(siteId)
			.first<{ ciphertext: string; revealed_at: number | null }>();
		expect(row?.ciphertext).toBe('');
		expect(row?.revealed_at).not.toBeNull();
	});

	it('lets exactly one of several parallel reveals through', async () => {
		const { siteId, orgId } = await sealed();
		const deps = await pendingDeps();
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, () => reveal(deps, orgId, siteId))
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		for (const result of results) {
			if (result.status === 'rejected')
				expect(result.reason).toMatchObject({ code: 'not_found' });
		}
	});

	it('answers not found for another organisation, an expired password and a site with none', async () => {
		const { siteId, orgId } = await sealed();
		const deps = await pendingDeps();
		await expect(reveal(deps, `org_${'z'.repeat(20)}`, siteId)).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(reveal(deps, orgId, `site_${'y'.repeat(20)}`)).rejects.toMatchObject({
			code: 'not_found'
		});
		const late: PendingSecretDeps = { ...deps, now: () => Date.now() + 120_000 };
		await expect(reveal(late, orgId, siteId)).rejects.toMatchObject({ code: 'not_found' });
		expect(await reveal(deps, orgId, siteId)).toBe(PASSWORD);
	});

	it('keeps both secrets readable by both sides after a rotation by re-wrap', async () => {
		const { siteId, orgId } = await sealed();
		const both = { KEK_V1: kek(1), KEK_V2: kek(2) };
		const deps = await pendingDeps(both);
		const owner: CustodyDeps = {
			store: collegeOwnerTokenStore(async () => db),
			audit: { append: async () => undefined },
			ring: await loadKeyRing(both)
		};
		expect(await rewrapOwnerToken(owner, { siteId, actor: 'system' })).toBe(true);
		expect(
			await rewrapPendingSecret(deps, { siteId, kind: 'admin-password', actor: 'system' })
		).toBe(true);
		const rotated = custodyOf({
			db: env.DB,
			secrets: { KEK_V2: kek(2) },
			pendingTtlMs: 60_000,
			now
		});
		expect(
			await rotated.withOwnerToken(siteId, `owner-token:${siteId}`, async (token) => token)
		).toBe('owner-token-0');
		expect(await reveal(await pendingDeps({ KEK_V2: kek(2) }), orgId, siteId)).toBe(PASSWORD);
	});

	it('discards both secrets of a site and no other site', async () => {
		const first = await sealed();
		const second = await sealed();
		await first.engine.discardPending(first.siteId);
		expect((await first.engine.sealed(first.siteId)).pendingSecretId).toBeNull();
		expect((await first.engine.sealed(first.siteId)).ownerTokenId).not.toBeNull();
		await first.engine.discard(first.siteId);
		expect(await first.engine.sealed(first.siteId)).toEqual({
			ownerTokenId: null,
			pendingSecretId: null
		});
		const other = await second.engine.sealed(second.siteId);
		expect(other.ownerTokenId).not.toBeNull();
		expect(other.pendingSecretId).not.toBeNull();
	});
});

describe('the scheduled purge of pending secrets', () => {
	const NOW = 5_000_000;

	async function seal(siteId: string, expiresAt: number, revealed = false) {
		await env.DB.prepare(PENDING_SECRET_SQL.seal)
			.bind(siteId, 'admin-password', 'ciphertext', 1, NOW - 1_000, expiresAt)
			.run();
		if (revealed) {
			await env.DB.prepare(PENDING_SECRET_SQL.reveal)
				.bind(NOW - 500, siteId, 'admin-password', NOW - 500)
				.run();
		}
	}

	const remaining = async () =>
		(
			await env.DB.prepare(
				"SELECT site_id FROM pending_secrets WHERE site_id LIKE 'site_purge%'"
			).all<{
				site_id: string;
			}>()
		).results
			.map((row) => row.site_id)
			.sort();

	it('deletes every secret past its expiry, read or not, and keeps the live ones', async () => {
		await seal('site_purge_expired', NOW - 1);
		await seal('site_purge_at_expiry', NOW);
		await seal('site_purge_read', NOW - 10, true);
		await seal('site_purge_live', NOW + 1);
		expect(await purgePendingSecrets(db, NOW)).toBe(3);
		expect(await remaining()).toEqual(['site_purge_live']);
	});

	it('removes nothing the second time', async () => {
		expect(await purgePendingSecrets(db, NOW)).toBe(0);
		expect(await remaining()).toEqual(['site_purge_live']);
	});

	it('leaves a secret that has not expired readable by the reveal path', async () => {
		const deps: PendingSecretDeps = {
			store: collegePendingSecretStore(async () => db),
			audit: { append: async () => undefined },
			ring: await loadKeyRing({ KEK_V1: kek(1) }),
			now: () => NOW
		};
		expect(await deps.store.get('site_purge_live', 'admin-password')).not.toBeNull();
		await purgePendingSecrets(db, NOW);
		expect(await deps.store.get('site_purge_live', 'admin-password')).not.toBeNull();
	});

	it('runs as a task over the cloudflare env the scheduler hands it', async () => {
		const task = purgeTask as unknown as {
			meta: { name: string };
			run(event: { context: unknown }): Promise<{ result: unknown }>;
		};
		expect(task.meta.name).toBe('pending-secrets-purge');
		await seal('site_purge_task', Date.now() - 1);
		const skipped = await task.run({ context: {} });
		expect(skipped.result).toMatchObject({ skipped: expect.any(String) });
		expect(await remaining()).toContain('site_purge_task');
		// the real clock is far past the fixed times of the earlier cases, so it takes those rows too
		const due = (await remaining()).length;
		const ran = await task.run({ context: { cloudflare: { env } } });
		expect(ran.result).toEqual({ removed: due });
		expect(await remaining()).toEqual([]);
	});

	it('stops with a typed error when a shard fails', async () => {
		const failing = {
			allAllShards: async () => [{ success: false, results: [], meta: {} }]
		} as unknown as CollegeDBClient;
		await expect(purgePendingSecrets(failing, NOW)).rejects.toBeInstanceOf(PurgeFailedError);
	});
});
