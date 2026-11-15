import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import rollbackCheck from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/rollback-check.get';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { registerRelease } from '../../../src/server/db/repos/releases';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { DEPT, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

const ORG = 'org-1';
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/rollback-check';
const NOW = 1_790_000_000_000;
const digest = `sha256:${'1'.repeat(64)}`;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	const db = await getDb();
	const base = { manifestDigest: digest, publishedAt: NOW, now: NOW };
	// the old code accepts data up to schema 1; the new release leaves a site at schema 2
	await registerRelease(db, {
		...base,
		id: 'rel-old',
		kind: 'worker',
		version: '1.0.0',
		schemaVersion: 1,
		acceptsSchema: 1
	});
	await registerRelease(db, {
		...base,
		id: 'rel-new',
		kind: 'worker',
		version: '1.1.0',
		schemaVersion: 2,
		acceptsSchema: 1
	});
	await registerRelease(db, {
		...base,
		id: 'rel-php',
		kind: 'php',
		version: '8.3.0',
		schemaVersion: 0,
		acceptsSchema: 0
	});
	setSiteServices({ getDb });
});

afterAll(() => harness.close());

afterEach(() => resetApiDeps());

async function liveSite(n: number, dataSchema: number | null, release = 'rel-new') {
	const id = `site_rbcheck${String(n).padStart(4, '0')}`;
	await env.DB.prepare(
		`INSERT INTO sites (id, organization_id, name, plane, state, release_id, ready_at,
			data_schema_version, created_at, updated_at)
		 VALUES (?, ?, ?, 'managed', 'active', ?, 1, ?, 1, 1)`
	)
		.bind(id, ORG, `Check ${n}`, release, dataSchema)
		.run();
	return id;
}

function asRole(role: 'viewer' | 'developer' | 'owner', orgId = ORG) {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId, departmentId: DEPT, siteId: input.params.id },
				facts: facts({ membership: { orgId, role }, ...fresh })
			})
		}
	});
}

const check = (siteId: string, query: string, orgId = ORG) =>
	send(rollbackCheck, ROUTE, {
		path: `/api/v1/orgs/${orgId}/sites/${siteId}/rollback-check${query}`,
		headers: asUser
	});

describe('GET rollback-check', () => {
	it('refuses a code-only rollback past the schema the old code accepts, with both offers', async () => {
		asRole('owner');
		const reply = await check(await liveSite(1, 2), '?release=rel-old');
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			release: 'rel-old',
			allowed: false,
			offers: ['restore-data-with-code', 'fix-forward']
		});
		expect((reply.json as { reason: string }).reason).toContain('Restore the data together');
	});

	it('allows a rollback when the data is within what the old code accepts', async () => {
		asRole('owner');
		const reply = await check(await liveSite(2, 1), '?release=rel-old');
		expect(reply.json).toMatchObject({ allowed: true, reason: null, offers: [] });
	});

	it('fails closed for a site whose data schema is unknown', async () => {
		asRole('owner');
		const reply = await check(await liveSite(3, null), '?release=rel-old');
		expect(reply.json).toMatchObject({ allowed: false });
		expect((reply.json as { reason: string }).reason).toContain("can't tell");
	});

	it('answers 404 for a release that is not registered and for a site in another organisation', async () => {
		asRole('owner');
		const siteId = await liveSite(4, 1);
		expect((await check(siteId, '?release=rel-nope')).status).toBe(404);
		expect((await check(`site_rbcheck9999`, '?release=rel-old')).status).toBe(404);
		asRole('owner', 'org-2');
		expect((await check(siteId, '?release=rel-old', 'org-1')).status).toBe(404);
	});

	it('answers 422 for a release of a different kind than the site runs', async () => {
		asRole('owner');
		const reply = await check(await liveSite(5, 1), '?release=rel-php');
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'release_kind_mismatch' } });
	});

	it('answers 400 when the release query parameter is missing', async () => {
		asRole('owner');
		expect((await check(await liveSite(6, 1), '')).status).toBe(400);
	});

	it('refuses a viewer', async () => {
		asRole('viewer');
		expect((await check(await liveSite(7, 1), '?release=rel-old')).status).toBe(403);
	});
});

afterAll(() => resetSiteServices());
