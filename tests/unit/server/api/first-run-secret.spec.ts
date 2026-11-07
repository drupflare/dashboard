import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../../contracts/src/common';
import firstRunState from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/first-run-secret.get';
import firstRunSecret from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/first-run-secret.post';
import type { PendingSecretRow } from '../../../../src/server/db/repos/pending-secrets';
import {
	resetPendingSecretDeps,
	setPendingSecretDeps,
	type PendingSecretStore
} from '../../../../src/server/services/owner-tokens';
import { resetSiteServices, setSiteServices } from '../../../../src/server/services/sites';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { createMemoryStore, type IdempotencyStore } from '../../../../src/server/utils/idempotency';
import { encryptRecord, loadKeyRing, type KeyRing } from '../../../../src/shared/custody/envelope';
import { pendingSecretAad } from '../../../../src/shared/custody/records';
import { DEPT, facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asOtherUser, asUser, send as sendRequest, setup } from '../fixtures/harness';

const MINE = 'site_aaaaaaaa';
const THEIRS = 'site_bbbbbbbb';
const PASSWORD = 'minted-admin-password-0123456789';
const NOW = 1_000_000;
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/first-run-secret';

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));

async function world(options: { expiresAt?: number; ring?: KeyRing } = {}) {
	const ring = options.ring ?? (await loadKeyRing({ KEK_V1: kek(1) }));
	const rows = new Map<string, PendingSecretRow>();
	const sites = new Map([
		[MINE, ORG],
		[THEIRS, OTHER_ORG]
	]);
	const seal = async (siteId: string) => {
		const envelope = await encryptRecord(
			PASSWORD,
			pendingSecretAad(siteId, 'admin-password'),
			await loadKeyRing({ KEK_V1: kek(1) })
		);
		rows.set(`${siteId}:admin-password`, {
			ciphertext: JSON.stringify(envelope),
			keyVersion: envelope.kv,
			createdAt: NOW - 1_000,
			expiresAt: options.expiresAt ?? NOW + 60_000,
			revealedAt: null
		});
	};
	await seal(MINE);
	await seal(THEIRS);
	const audits: { actor: string; action: string; target: string; detail: unknown }[] = [];
	const store: PendingSecretStore = {
		async get(siteId, kind) {
			const row = rows.get(`${siteId}:${kind}`);
			return row ? { ...row } : null;
		},
		async markRevealed(siteId, kind, at) {
			const row = rows.get(`${siteId}:${kind}`);
			if (!row || row.revealedAt !== null || row.expiresAt <= at) return false;
			row.revealedAt = at;
			row.ciphertext = '';
			return true;
		},
		async replaceCiphertext() {
			return false;
		},
		async siteInOrganization(orgId, siteId) {
			return sites.get(siteId) === orgId;
		}
	};
	setPendingSecretDeps(async () => ({
		store,
		audit: {
			async append(input) {
				audits.push({ ...input, detail: input.detail });
			}
		},
		ring,
		now: () => NOW
	}));
	return { rows, audits };
}

function api(overrides: Parameters<typeof setup>[0] = {}) {
	return setup(overrides);
}

const reveal = (
	headers: Record<string, string> = asUser,
	orgId: string = ORG,
	siteId: string = MINE
) =>
	sendRequest(firstRunSecret, ROUTE, {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/sites/${siteId}/first-run-secret`,
		headers
	});

const siteRow = (adminName: string | null) => ({
	id: MINE,
	organization_id: ORG,
	name: 'Quiet Otter',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	account_id: null,
	state: 'active',
	primary_hostname: 'quiet-otter.drupflare.app',
	release_id: null,
	admin_name: adminName,
	admin_mail: adminName === null ? null : 'owner@example.com',
	ready_at: 1,
	created_at: 1,
	updated_at: 1
});

// the site table answers for the one site of this organisation; anything else is not there
function siteTable(adminName: string | null = 'admin') {
	setSiteServices({
		getDb: async () =>
			({
				first: async (_key: string, _sql: string, params: string[]) =>
					params[0] === ORG && params[1] === MINE ? siteRow(adminName) : null
			}) as unknown as CollegeDBClient
	});
}

const readState = (
	headers: Record<string, string> = asUser,
	orgId: string = ORG,
	siteId: string = MINE
) =>
	sendRequest(firstRunState, ROUTE, {
		method: 'GET',
		path: `/api/v1/orgs/${orgId}/sites/${siteId}/first-run-secret`,
		headers
	});

afterEach(() => {
	resetPendingSecretDeps();
	resetSiteServices();
	resetApiDeps();
});

describe('GET /api/v1/orgs/:orgId/sites/:id/first-run-secret', () => {
	it('says available for an unread password, uncached, and does not read it', async () => {
		const { rows, audits } = await world();
		siteTable();
		api();
		const reply = await readState();
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ kind: 'admin-password', state: 'available' });
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
		expect(audits).toEqual([]);
		expect((await reveal()).status).toBe(200);
	});

	it('says revealed once the password was read', async () => {
		await world();
		siteTable();
		api();
		await reveal();
		expect((await readState()).json).toEqual({ kind: 'admin-password', state: 'revealed' });
	});

	it('says expired for a password past its expiry', async () => {
		await world({ expiresAt: NOW });
		siteTable();
		api();
		expect((await readState()).json).toEqual({ kind: 'admin-password', state: 'expired' });
	});

	it('says expired when the purge removed the row from a site that recorded its admin', async () => {
		const { rows } = await world();
		rows.delete(`${MINE}:admin-password`);
		siteTable('admin');
		api();
		expect((await readState()).json).toEqual({ kind: 'admin-password', state: 'expired' });
	});

	it('says unknown for a site that predates the admin columns and has no row', async () => {
		const { rows } = await world();
		rows.delete(`${MINE}:admin-password`);
		siteTable(null);
		api();
		expect((await readState()).json).toEqual({ kind: 'admin-password', state: 'unknown' });
	});

	it('refuses an API key even when the key holds the scope', async () => {
		await world();
		siteTable();
		api({
			facts: (input) => ({
				...facts({ ...member('owner'), ...fresh }),
				...(input.principal.kind === 'key'
					? { key: { id: 'key-1', scopes: ['site.create'] } }
					: {})
			})
		});
		const reply = await readState(asKey);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			code: 'forbidden',
			details: { reason: 'session_only' }
		});
	});

	it('answers 404 for a site that is not in the organisation', async () => {
		await world();
		siteTable();
		api();
		expect((await readState(asUser, ORG, THEIRS)).status).toBe(404);
	});

	it('refuses a member who cannot create sites, and a caller without a session', async () => {
		await world();
		siteTable();
		api({ role: 'viewer' });
		expect((await readState()).status).toBe(403);
		api();
		expect((await readState({})).status).toBe(401);
	});

	it('answers 501 until a secret store is installed', async () => {
		siteTable();
		api();
		const reply = await readState();
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});
});

describe('POST /api/v1/orgs/:orgId/sites/:id/first-run-secret', () => {
	it('gives the password once to a member who can create sites, uncached', async () => {
		const { audits } = await world();
		api();
		const first = await reveal();
		expect(first.status).toBe(200);
		expect(first.json).toEqual({ kind: 'admin-password', value: PASSWORD });
		expect(first.headers.get('cache-control')).toBe('no-store');
		const second = await reveal();
		expect(second.status).toBe(404);
		expect(second.text).not.toContain(PASSWORD);
		expect(audits.map((row) => row.action)).toEqual(['site.pending-secret.reveal']);
		expect(JSON.stringify(audits)).not.toContain(PASSWORD);
	});

	it('answers one of two parallel requests and refuses the other', async () => {
		await world();
		api();
		const replies = await Promise.all([reveal(), reveal()]);
		expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404]);
		const loser = replies.find((reply) => reply.status === 404)!;
		expect(loser.text).not.toContain(PASSWORD);
	});

	it('answers 404 for a password past its expiry', async () => {
		await world({ expiresAt: NOW });
		api();
		const reply = await reveal();
		expect(reply.status).toBe(404);
		expect(reply.text).not.toContain(PASSWORD);
	});

	it('answers 404 for a site of another organisation and leaves its password unread', async () => {
		const { rows } = await world();
		api();
		const reply = await reveal(asUser, ORG, THEIRS);
		expect(reply.status).toBe(404);
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${THEIRS}:admin-password`)?.revealedAt).toBeNull();
	});

	it('answers 404 when the loader finds no organisation for the caller', async () => {
		const { rows } = await world();
		api({ deps: { load: async () => null } });
		const reply = await reveal(asOtherUser, 'org-9');
		expect(reply.status).toBe(404);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
	});

	it('answers 404 when the path names an organisation other than the loaded one', async () => {
		const { rows } = await world();
		api({
			deps: {
				load: async () => ({
					resource: { orgId: ORG, departmentId: DEPT },
					facts: facts({ ...member('owner'), ...fresh })
				})
			}
		});
		const reply = await reveal(asUser, OTHER_ORG, THEIRS);
		expect(reply.status).toBe(404);
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${THEIRS}:admin-password`)?.revealedAt).toBeNull();
	});

	it('refuses a member of one organisation who names another organisation in the path', async () => {
		const { rows } = await world();
		api();
		const reply = await reveal(asUser, OTHER_ORG, THEIRS);
		expect(reply.status).toBe(403);
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${THEIRS}:admin-password`)?.revealedAt).toBeNull();
	});

	it('refuses an API key even when the key holds the scope, and leaves the password unread', async () => {
		const { rows, audits } = await world();
		api({
			facts: (input) => ({
				...facts({ ...member('owner'), ...fresh }),
				...(input.principal.kind === 'key'
					? { key: { id: 'key-1', scopes: ['site.create'] } }
					: {})
			})
		});
		const reply = await reveal(asKey);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			code: 'forbidden',
			details: { reason: 'session_only' }
		});
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
		expect(audits).toEqual([]);
	});

	it('refuses a member who cannot create sites', async () => {
		const { rows } = await world();
		api({ role: 'viewer' });
		const reply = await reveal();
		expect(reply.status).toBe(403);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
	});

	it('answers 401 without a session', async () => {
		await world();
		api();
		expect((await reveal({})).status).toBe(401);
	});

	it('refuses an Idempotency-Key, so no replayed answer ever stores the password', async () => {
		const { rows } = await world();
		const puts: unknown[] = [];
		const inner = createMemoryStore();
		const idempotency: IdempotencyStore = {
			claim: (key, fingerprint) => inner.claim(key, fingerprint),
			put: async (key, record) => {
				puts.push(record);
				return inner.put(key, record);
			},
			release: (key) => inner.release(key)
		};
		api({ deps: { idempotency } });
		const reply = await reveal({ ...asUser, 'idempotency-key': 'reveal-0001' });
		expect(reply.status).toBe(400);
		expect(reply.text).not.toContain(PASSWORD);
		expect(puts).toEqual([]);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
		expect((await reveal()).status).toBe(200);
	});

	it('answers 501 until a secret store is installed', async () => {
		api();
		const reply = await reveal();
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});

	it('answers 500 for a record the key ring cannot open, keeps it unread and prints no secret', async () => {
		const { rows } = await world({ ring: await loadKeyRing({ KEK_V1: kek(2) }) });
		const { errors } = api();
		const reply = await reveal();
		expect(reply.status).toBe(500);
		expect(reply.text).not.toContain(PASSWORD);
		expect(rows.get(`${MINE}:admin-password`)?.revealedAt).toBeNull();
		expect(errors.map(String).join(' ')).not.toContain(PASSWORD);
	});
});
