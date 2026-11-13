import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { importStoreOf } from '../../../engine/src/adapters/import-store';
import { encryptRecord, loadKeyRing } from '../../../src/shared/custody/envelope';
import {
	IMPORT_CREDENTIAL_TTL_MS,
	importCredentialAad
} from '../../../src/shared/custody/import-credentials';
import { makeWorld } from './fakes';
import {
	credentialRows,
	DAY_MS,
	KEK,
	PRIVATE_KEY,
	ROOT,
	sealCredential,
	SERVER_FINGERPRINT,
	SOURCE_HOST
} from './import-fakes';

async function setup(options: { fingerprint?: string | null; expiresAt?: number } = {}) {
	const world = await makeWorld();
	const now = world.clock.now();
	const id = await sealCredential(world, { orgId: world.orgId, now, ...options });
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const store = importStoreOf({ db, secrets: KEK, now: world.clock.now });
	return { world, id, store };
}

const failureOf = async (promise: Promise<unknown>): Promise<Error> =>
	(await promise.then(
		() => new Error('expected a refusal'),
		(caught: unknown) => caught
	)) as Error;

describe('withTarget', () => {
	it('opens the key for one call and hands over the confirmed fingerprint', async () => {
		const { world, id, store } = await setup();
		const seen = await store.withTarget(id, world.orgId, ROOT, async (target) => target);
		expect(seen).toEqual({
			host: SOURCE_HOST,
			port: 22,
			user: 'deploy',
			privateKey: PRIVATE_KEY,
			expectedFingerprint: SERVER_FINGERPRINT,
			root: ROOT
		});
		const row = world.sqlite.prepare('SELECT used_at FROM import_credentials').get() as {
			used_at: number;
		};
		expect(row.used_at).toBe(world.clock.now());
	});

	it('stores the key only as an envelope that does not contain it', async () => {
		const { world } = await setup();
		const row = world.sqlite.prepare('SELECT * FROM import_credentials').get() as Record<
			string,
			unknown
		>;
		expect(JSON.stringify(row)).not.toContain('KEYBODY');
		expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
	});

	it('refuses an expired key, an unconfirmed host key and a missing row with plain codes', async () => {
		const expired = await setup({ expiresAt: 1 });
		expect(
			await failureOf(
				expired.store.withTarget(expired.id, expired.world.orgId, ROOT, async () => 1)
			)
		).toMatchObject({ code: 'credential_expired' });
		const unconfirmed = await setup({ fingerprint: null });
		expect(
			await failureOf(
				unconfirmed.store.withTarget(
					unconfirmed.id,
					unconfirmed.world.orgId,
					ROOT,
					async () => 1
				)
			)
		).toMatchObject({ code: 'host_key_unconfirmed' });
		const missing = await setup();
		expect(
			await failureOf(
				missing.store.withTarget('imc_none', missing.world.orgId, ROOT, async () => 1)
			)
		).toMatchObject({ code: 'credential_missing' });
	});

	it('refuses another organization and a row sealed to another id', async () => {
		const { world, id, store } = await setup();
		expect(
			await failureOf(store.withTarget(id, `org_${'q'.repeat(26)}`, ROOT, async () => 1))
		).toMatchObject({ code: 'credential_missing' });
		// an envelope copied onto a different credential fails to open
		const ring = await loadKeyRing(KEK);
		const forged = await encryptRecord(PRIVATE_KEY, importCredentialAad('imc_other'), ring);
		world.sqlite
			.prepare('UPDATE import_credentials SET key_envelope = ?')
			.run(JSON.stringify(forged));
		const error = await failureOf(store.withTarget(id, world.orgId, ROOT, async () => 1));
		expect(error.message).not.toContain('KEYBODY');
		expect(error.name).toBe('CryptoError');
	});

	it('does not run the callback when it refuses', async () => {
		const { world, id, store } = await setup({ fingerprint: null });
		let ran = false;
		await failureOf(
			store.withTarget(id, world.orgId, ROOT, async () => {
				ran = true;
			})
		);
		expect(ran).toBe(false);
	});
});

describe('discard and markImported', () => {
	it('deletes the row and a repeat is harmless', async () => {
		const { id, store, world } = await setup();
		await store.discard(id);
		await store.discard(id);
		expect(credentialRows(world)).toEqual([]);
	});

	it('records the host and the account on the new site', async () => {
		const { world, id, store } = await setup();
		const now = world.clock.now();
		world.sqlite
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
				 VALUES (?, ?, 'New', 'managed', 'active', ?, ?)`
			)
			.run(world.siteId, world.orgId, now, now);
		await store.markImported(world.siteId, id, world.accountId, now + 5);
		expect(
			world.sqlite
				.prepare('SELECT imported_from, account_id FROM sites WHERE id = ?')
				.get(world.siteId)
		).toEqual({ imported_from: SOURCE_HOST, account_id: world.accountId });
	});

	it('writes nothing when the key is already gone', async () => {
		const { world, id, store } = await setup();
		const now = world.clock.now();
		world.sqlite
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
				 VALUES (?, ?, 'New', 'managed', 'active', ?, ?)`
			)
			.run(world.siteId, world.orgId, now, now);
		await store.discard(id);
		await store.markImported(world.siteId, id, world.accountId, now);
		expect(
			world.sqlite.prepare('SELECT imported_from FROM sites WHERE id = ?').get(world.siteId)
		).toEqual({ imported_from: null });
	});
});

describe('the expiry window', () => {
	it('is 24 hours from creation', () => {
		expect(IMPORT_CREDENTIAL_TTL_MS).toBe(DAY_MS);
		expect(IMPORT_CREDENTIAL_TTL_MS).toBe(86_400_000);
	});
});
