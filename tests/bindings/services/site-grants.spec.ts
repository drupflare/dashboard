import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { createUser } from '../../../src/server/db/repos/identity';
import { createOrganization } from '../../../src/server/db/repos/organization';
import {
	changeGrant,
	grantSite,
	listGrants,
	revokeGrant,
	type SiteGrantServices
} from '../../../src/server/services/site-grants';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const email = (tag: string) => `${tag}-${crypto.randomUUID()}@example.test`;

function services(now = Date.now()): SiteGrantServices {
	return { getDb: async () => db, audit: vi.fn(async () => undefined), now: () => now };
}

async function setup() {
	const owner = await createUser(db, { email: email('owner') });
	const org = await createOrganization(db, {
		name: 'Grants Test',
		personal: false,
		createdBy: owner.id
	});
	const collaborator = await createUser(db, { email: email('collab') });
	return {
		orgId: org.id,
		siteId: `site-${crypto.randomUUID()}`,
		actor: { principal: { kind: 'user' as const, userId: owner.id }, userId: owner.id },
		collaborator
	};
}

describe('site grants', () => {
	it('refuses an email that has no account yet', async () => {
		const { orgId, siteId, actor } = await setup();
		await expect(
			grantSite(services(), orgId, siteId, actor, {
				email: email('nobody'),
				role: 'viewer',
				expiry: 'never'
			})
		).rejects.toMatchObject({ code: 'unprocessable' });
	});

	it('grants a role with an expiry, and refuses a second grant on the same site', async () => {
		const now = Date.parse('2026-11-01T00:00:00Z');
		const { orgId, siteId, actor, collaborator } = await setup();
		const granted = await grantSite(services(now), orgId, siteId, actor, {
			email: collaborator.email,
			role: 'maintainer',
			expiry: '30d'
		});
		expect(granted.role).toBe('maintainer');
		expect(granted.inOrganization).toBe(false);
		expect(Date.parse(granted.expiresAt!)).toBe(now + 30 * 24 * 60 * 60 * 1000);
		await expect(
			grantSite(services(now), orgId, siteId, actor, {
				email: collaborator.email,
				role: 'viewer',
				expiry: 'never'
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('keeps the expiry on a role change, and revoking twice changes nothing', async () => {
		const now = Date.parse('2026-11-01T00:00:00Z');
		const { orgId, siteId, actor, collaborator } = await setup();
		const granted = await grantSite(services(now), orgId, siteId, actor, {
			email: collaborator.email,
			role: 'viewer',
			expiry: '90d'
		});
		const changed = await changeGrant(services(now), orgId, siteId, actor, granted.id, {
			role: 'site-admin',
			expiry: 'keep'
		});
		expect(changed.role).toBe('site-admin');
		expect(changed.expiresAt).toBe(granted.expiresAt);

		await revokeGrant(services(now), orgId, siteId, actor, granted.id);
		await revokeGrant(services(now), orgId, siteId, actor, granted.id);
		expect(await listGrants(services(now), orgId, siteId)).toEqual([]);
		await expect(
			changeGrant(services(now), orgId, siteId, actor, granted.id, {
				role: 'viewer',
				expiry: 'keep'
			})
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('does not reach a grant that names another site', async () => {
		const { orgId, siteId, actor, collaborator } = await setup();
		const granted = await grantSite(services(), orgId, siteId, actor, {
			email: collaborator.email,
			role: 'viewer',
			expiry: 'never'
		});
		await expect(
			revokeGrant(services(), orgId, `other-${siteId}`, actor, granted.id)
		).rejects.toMatchObject({ code: 'not_found' });
	});
});
