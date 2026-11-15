import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1StrataStore } from '../../../engine/src/adapters/strata';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { insertPlaneConnection } from '../../../src/server/db/repos/plane-connections';
import {
	getSiteStrata,
	saveSiteStrata,
	selfManagedStorageCheck
} from '../../../src/server/db/repos/site-strata';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: ReturnType<typeof createCollegeDB>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const NOW = 1_790_000_000_000;

describe('site strata', () => {
	it('reads null for a site that never chose', async () => {
		expect(await getSiteStrata(db, 'org_a', 'site_none')).toBeNull();
	});

	it('keeps the free confirmation when a later save does not carry one', async () => {
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_one',
			allocation: 'light',
			confirmedFreeAt: NOW,
			now: NOW
		});
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_one',
			allocation: 'detailed',
			now: NOW + 1
		});
		expect(await getSiteStrata(db, 'org_a', 'site_one')).toMatchObject({
			allocation: 'detailed',
			confirmedFreeAt: NOW,
			appliedAt: null,
			updatedAt: NOW + 1
		});
	});

	it('clears applied when the allocation changes and keeps it when it does not', async () => {
		await db.run(
			'site_two',
			'INSERT INTO site_strata (site_id, organization_id, allocation, applied_at, confirmed_free_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
			['site_two', 'org_a', 'light', NOW, null, NOW]
		);
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_two',
			allocation: 'light',
			now: NOW + 1
		});
		expect((await getSiteStrata(db, 'org_a', 'site_two'))?.appliedAt).toBe(NOW);
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_two',
			allocation: 'detailed',
			now: NOW + 2
		});
		expect((await getSiteStrata(db, 'org_a', 'site_two'))?.appliedAt).toBeNull();
	});

	it('starts with no store and keeps the engine write across a later save', async () => {
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_three',
			allocation: 'light',
			now: NOW
		});
		expect(await getSiteStrata(db, 'org_a', 'site_three')).toMatchObject({
			store: 'none',
			storeReason: null
		});
		const engine = new D1StrataStore(env.DB);
		await engine.markStore('org_a', 'site_three', { state: 'failed', reason: 'token_quota' });
		expect(await getSiteStrata(db, 'org_a', 'site_three')).toMatchObject({
			store: 'failed',
			storeReason: 'token_quota'
		});
		await saveSiteStrata(db, {
			organizationId: 'org_a',
			siteId: 'site_three',
			allocation: 'detailed',
			now: NOW + 1
		});
		expect(await getSiteStrata(db, 'org_a', 'site_three')).toMatchObject({
			store: 'failed',
			storeReason: 'token_quota'
		});
		await engine.markStore('org_a', 'site_three', { state: 'ready' });
		expect(await getSiteStrata(db, 'org_a', 'site_three')).toMatchObject({
			store: 'ready',
			storeReason: null
		});
	});

	it('leaves another organisation and a site with no row alone when the engine marks a store', async () => {
		const engine = new D1StrataStore(env.DB);
		await engine.markStore('org_b', 'site_three', {
			state: 'failed',
			reason: 'storage_failed'
		});
		await engine.markStore('org_a', 'site_missing', { state: 'ready' });
		expect((await getSiteStrata(db, 'org_a', 'site_three'))?.store).toBe('ready');
		expect(await getSiteStrata(db, 'org_a', 'site_missing')).toBeNull();
	});

	it('does not read a site through another organisation', async () => {
		expect(await getSiteStrata(db, 'org_b', 'site_one')).toBeNull();
	});
});

describe('the storage check on a self-managed account', () => {
	const connect = (
		accountId: string,
		state: 'active' | 'invalid',
		storage: 'granted' | 'missing' | 'not-enabled' | 'unknown'
	) =>
		insertPlaneConnection(db, {
			id: `conn_${accountId}`,
			organizationId: 'org_s',
			provider: 'cloudflare',
			accountId,
			accountName: 'Customer',
			tokenKind: 'account',
			tokenId: null,
			minted: false,
			credentialEnvelope: null,
			capabilities: [
				{
					id: 'storage',
					label: 'Object storage',
					state: storage,
					permission: 'p',
					retryHint: null
				}
			],
			workersSubdomain: null,
			expiresOn: null,
			state,
			createdAt: NOW,
			lastValidatedAt: NOW,
			revokedAt: null
		});

	it('names each state from the stored connection', async () => {
		await connect('acct_ok', 'active', 'granted');
		await connect('acct_off', 'active', 'not-enabled');
		await connect('acct_narrow', 'active', 'missing');
		await connect('acct_stale', 'invalid', 'granted');
		expect(await selfManagedStorageCheck(db, 'org_s', 'acct_ok')).toBe('ok');
		expect(await selfManagedStorageCheck(db, 'org_s', 'acct_off')).toBe('needs_object_storage');
		expect(await selfManagedStorageCheck(db, 'org_s', 'acct_narrow')).toBe('needs_wider_token');
		expect(await selfManagedStorageCheck(db, 'org_s', 'acct_stale')).toBe('unchecked');
	});

	it('reports unchecked with no connection, no account or another organisation', async () => {
		expect(await selfManagedStorageCheck(db, 'org_s', 'acct_none')).toBe('unchecked');
		expect(await selfManagedStorageCheck(db, 'org_s', null)).toBe('unchecked');
		expect(await selfManagedStorageCheck(db, 'org_other', 'acct_ok')).toBe('unchecked');
	});
});
