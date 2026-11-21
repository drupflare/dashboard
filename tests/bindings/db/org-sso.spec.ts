import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	getOrgSso,
	getOrgSsoBySlug,
	markOrgSsoVerified,
	saveOrgSso,
	type OrgSsoRow
} from '../../../src/server/db/repos/org-sso';
import { openBindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env);
});

afterAll(() => open.close());

const row = (over: Partial<OrgSsoRow> = {}): OrgSsoRow => ({
	organizationId: `org-${crypto.randomUUID()}`,
	slug: `school-${crypto.randomUUID().slice(0, 8)}`,
	issuer: 'https://idp.example.edu',
	clientId: 'client',
	clientSecretEnvelope: '{"v":1}',
	allowedDomains: ['example.edu'],
	roleMap: [{ group: 'web', role: 'admin' }],
	groupClaim: 'groups',
	defaultRole: 'viewer',
	enabled: false,
	lastVerifiedAt: null,
	createdAt: 1000,
	updatedAt: 1000,
	...over
});

describe('org_sso', () => {
	it('round-trips a row by organisation and by slug', async () => {
		const saved = row();
		await saveOrgSso(db, saved);
		expect(await getOrgSso(db, saved.organizationId)).toEqual(saved);
		expect(await getOrgSsoBySlug(db, saved.slug)).toEqual(saved);
		expect(await getOrgSso(db, 'org-missing')).toBeNull();
	});

	it('updates in place for the same organisation and records a verification', async () => {
		const saved = row();
		await saveOrgSso(db, saved);
		await saveOrgSso(db, {
			...saved,
			enabled: true,
			allowedDomains: ['a.edu', 'b.edu'],
			updatedAt: 2000
		});
		const after = await getOrgSso(db, saved.organizationId);
		expect(after).toMatchObject({
			enabled: true,
			allowedDomains: ['a.edu', 'b.edu'],
			createdAt: 1000
		});
		expect(await markOrgSsoVerified(db, saved.organizationId, 3000)).toBe(true);
		expect((await getOrgSso(db, saved.organizationId))?.lastVerifiedAt).toBe(3000);
		expect(await markOrgSsoVerified(db, 'org-missing', 3000)).toBe(false);
	});

	it('refuses a slug that another organisation holds', async () => {
		const first = row();
		await saveOrgSso(db, first);
		await expect(saveOrgSso(db, row({ slug: first.slug }))).rejects.toBeInstanceOf(
			DuplicateRowError
		);
	});
});
