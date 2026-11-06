import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_BUDGET } from '../../../contracts/src/operations';
import {
	applySchema,
	createCollegeDB,
	DuplicateRowError,
	ensureCollegeDB
} from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	appendOperationStep,
	createSiteOperation,
	getOperation,
	listOperationsForSite,
	updateOperationStatus
} from '../../../src/server/db/repos/operations';
import { getSiteDiscovery, upsertSiteDiscovery } from '../../../src/server/db/repos/site-discovery';
import {
	insertSiteResource,
	listLiveSiteResources
} from '../../../src/server/db/repos/site-resources';
import {
	getReadySite,
	listReadySites,
	markSiteReady,
	setSiteState,
	toSite
} from '../../../src/server/db/repos/sites';
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

const ORG = 'org_bindings1';
const OTHER = 'org_bindings2';

let counter = 0;
const next = () => `${++counter}`.padStart(8, '0');

// a create with its own site and operation; the key is unique unless a test repeats it
function newCreate(org: string, now: number, key = `key-${next()}`) {
	const siteId = `site_${next()}${next()}`;
	const operationId = `op_${next()}${next()}`;
	return createSiteOperation(
		db,
		{
			id: siteId,
			organizationId: org,
			name: `site-${siteId}`,
			kind: 'drupal',
			category: 'cms',
			plane: 'managed',
			config: 'managed',
			primaryHostname: `${siteId}.drupflare.app`,
			now
		},
		{
			id: operationId,
			organizationId: org,
			accountId: null,
			siteId,
			type: 'site.create',
			status: 'planned',
			idempotencyKey: key,
			targetIds: [siteId],
			preconditions: [],
			planDigest: `sha256:${'a'.repeat(64)}`,
			blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
			rollbackPoint: null,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: [],
			now
		}
	);
}

describe('site rows', () => {
	it('lists only ready sites, in id order, one page at a time', async () => {
		const org = `${ORG}-paging`;
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { operation } = await newCreate(org, 1_000 + i);
			ids.push(operation.operation.targetIds[0] as string);
		}
		const unready = ids[4] as string;
		for (const id of ids.slice(0, 4))
			expect(await markSiteReady(db, org, id, 2_000)).toBe(true);

		const seen: string[] = [];
		let after: string | undefined;
		for (;;) {
			const page = await listReadySites(db, org, { after, count: 2 });
			seen.push(...page.map((row) => row.id));
			if (page.length < 2) break;
			after = page.at(-1)?.id;
		}
		expect(seen).toEqual([...ids.slice(0, 4)].sort());
		expect(seen).not.toContain(unready);
	});

	it('hides a site from reads until its create finishes, and from other organisations', async () => {
		const org = `${ORG}-visibility`;
		const { operation } = await newCreate(org, 1_000);
		const id = operation.operation.targetIds[0] as string;
		expect(await getReadySite(db, org, id)).toBeNull();
		await markSiteReady(db, org, id, 2_000);
		expect(await getReadySite(db, org, id)).toMatchObject({ id, readyAt: 2_000 });
		expect(await getReadySite(db, OTHER, id)).toBeNull();
	});

	it('maps a ready row to the contract site, with the managed host and no ring data', async () => {
		const org = `${ORG}-mapping`;
		const { operation } = await newCreate(org, 1_000);
		const id = operation.operation.targetIds[0] as string;
		await markSiteReady(db, org, id, 2_000);
		const record = await getReadySite(db, org, id);
		expect(record).not.toBeNull();
		const site = toSite(record!);
		expect(site).toMatchObject({
			id,
			kind: 'drupal',
			category: 'cms',
			plane: 'managed',
			config: 'managed',
			state: 'active',
			ring: 'R0',
			primaryHostname: `${id}.drupflare.app`,
			hostnames: [`${id}.drupflare.app`],
			createdAt: new Date(1_000).toISOString()
		});
	});

	it('updates state and refuses a second ready mark', async () => {
		const org = `${ORG}-state`;
		const { operation } = await newCreate(org, 1_000);
		const id = operation.operation.targetIds[0] as string;
		expect(await markSiteReady(db, org, id, 2_000)).toBe(true);
		expect(await markSiteReady(db, org, id, 3_000)).toBe(false);
		expect(await setSiteState(db, org, id, 'suspended', 4_000)).toBe(true);
		expect(await getReadySite(db, org, id)).toMatchObject({
			state: 'suspended',
			readyAt: 2_000
		});
	});
});

describe('operation rows', () => {
	it('a repeated key returns the first operation and adds no second site', async () => {
		const org = `${ORG}-idem`;
		const key = 'repeat-0001';
		const first = await newCreate(org, 1_000, key);
		const second = await newCreate(org, 1_500, key);
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.operation.operation.id).toBe(first.operation.operation.id);
		const sites = await env.DB.prepare(
			'SELECT count(*) AS n FROM sites WHERE organization_id = ?'
		)
			.bind(org)
			.first<{ n: number }>();
		expect(sites?.n).toBe(1);
	});

	it('refuses a stale status write and keeps the newer one', async () => {
		const org = `${ORG}-cas`;
		const { operation } = await newCreate(org, 1_000);
		const id = operation.operation.id;
		expect(operation.version).toBe(0);
		expect(await updateOperationStatus(db, org, id, 0, 'running', 2_000)).toBe(true);
		expect(await updateOperationStatus(db, org, id, 0, 'failed', 3_000)).toBe(false);
		const latest = await getOperation(db, org, id);
		expect(latest).toMatchObject({ version: 1 });
		expect(latest?.operation.status).toBe('running');
	});

	it('keeps steps in the order they were appended and refuses a repeated step id', async () => {
		const org = `${ORG}-steps`;
		const { operation } = await newCreate(org, 1_000);
		const id = operation.operation.id;
		await appendOperationStep(db, org, id, {
			id: 'lease',
			name: 'Take the lease',
			state: 'pending'
		});
		await appendOperationStep(db, org, id, {
			id: 'reserve',
			name: 'Reserve',
			state: 'pending'
		});
		await expect(
			appendOperationStep(db, org, id, { id: 'lease', name: 'Again', state: 'pending' })
		).rejects.toBeInstanceOf(DuplicateRowError);
		const stored = await getOperation(db, org, id);
		expect(stored?.operation.steps.map((step) => step.id)).toEqual(['lease', 'reserve']);
	});

	it("pages a site's operations newest first with a keyset cursor", async () => {
		const org = `${ORG}-list`;
		const { operation } = await newCreate(org, 1_000);
		const siteId = operation.operation.targetIds[0] as string;
		for (const [index, at] of [2_000, 3_000].entries()) {
			await env.DB.prepare(
				`INSERT INTO operations (id, organization_id, site_id, type, status, idempotency_key,
				 target_ids, preconditions, plan_digest, fencing_epoch, blast_radius, verification,
				 budget, created_at, updated_at, version)
				 VALUES (?, ?, ?, 'site.upgrade', 'planned', ?, '[]', '[]', ?, 0, '{}', 'pending',
				 '{}', ?, ?, 0)`
			)
				.bind(
					`op_list${index}`,
					org,
					siteId,
					`list-${index}`,
					`sha256:${'b'.repeat(64)}`,
					at,
					at
				)
				.run();
		}
		const firstPage = await listOperationsForSite(db, org, siteId, { count: 2 });
		expect(firstPage.map((row) => row.operation.createdAt)).toEqual([
			new Date(3_000).toISOString(),
			new Date(2_000).toISOString()
		]);
		const last = firstPage[1]!.operation;
		const rest = await listOperationsForSite(db, org, siteId, {
			after: { createdAt: Date.parse(last.createdAt), id: last.id },
			count: 2
		});
		expect(rest.map((row) => row.operation.createdAt)).toEqual([new Date(1_000).toISOString()]);
	});
});

describe('site resources and discovery', () => {
	it('lists the live resources of a site and refuses a second live binding', async () => {
		const siteId = `site_res${next()}`;
		const base = {
			siteId,
			accountId: 'a'.repeat(32),
			kind: 'kv' as const,
			createdByOperation: 'op_res0000001',
			createdAt: 1_000
		};
		await insertSiteResource(db, {
			...base,
			id: 'res_one',
			binding: 'CONFIG_KV',
			name: 'one',
			providerId: 'p1'
		});
		await insertSiteResource(db, {
			...base,
			id: 'res_two',
			binding: 'PAGE_KV',
			name: 'two',
			providerId: 'p2',
			createdAt: 2_000
		});
		const live = await listLiveSiteResources(db, siteId);
		expect(live.map((row) => row.binding)).toEqual(['CONFIG_KV', 'PAGE_KV']);
		await expect(
			insertSiteResource(db, {
				...base,
				id: 'res_three',
				binding: 'CONFIG_KV',
				name: 'three',
				providerId: 'p3'
			})
		).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('keeps the latest discovery document and its etag', async () => {
		const siteId = `site_disc${next()}`;
		expect(await getSiteDiscovery(db, siteId)).toBeNull();
		await upsertSiteDiscovery(db, {
			siteId,
			document: { v: 1 },
			etag: '"one"',
			fetchedAt: 1_000
		});
		await upsertSiteDiscovery(db, {
			siteId,
			document: { v: 2 },
			etag: '"two"',
			fetchedAt: 2_000
		});
		expect(await getSiteDiscovery(db, siteId)).toEqual({
			siteId,
			document: { v: 2 },
			etag: '"two"',
			fetchedAt: 2_000
		});
	});
});
