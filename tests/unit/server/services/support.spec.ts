import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, createOrganization } from '../../../../src/server/db/repos/organization';
import { listPlatformAudit } from '../../../../src/server/db/repos/platform-audit';
import { auditWriters } from '../../../../src/server/services/boot';
import { loadFacts, type FactsStore } from '../../../../src/server/services/facts';
import {
	createGrant,
	listAdminGrants,
	listOrgGrants,
	revokeGrant,
	startBreakGlass,
	supportStanding,
	type SupportServices
} from '../../../../src/server/services/support';
import {
	BREAK_GLASS_MAX_PER_DAY,
	BREAK_GLASS_MS,
	SUPPORT_GRANT_MAX_MS
} from '../../../../src/shared/support';
import { sqliteClient } from '../fixtures/sqlite-client';
import { memoryHeads } from './audit-support';

const OWNER = { kind: 'user', userId: 'usr_owner' } as const;
const ADMIN = { kind: 'user', userId: 'usr_admin' } as const;
const HOUR = 3_600_000;

async function world() {
	const { client, raw } = sqliteClient();
	const org = await createOrganization(client, {
		name: 'Campus',
		personal: false,
		createdBy: OWNER.userId
	});
	await addMember(client, org.id, { userId: OWNER.userId, role: 'owner' });
	let now = 1_800_000_000_000;
	let n = 0;
	const audits: { orgId: string; action: string; detail?: Record<string, unknown> }[] = [];
	const mails: { to: string; summary: string; reviewPath: string }[] = [];
	const owners = ['a@example.test', 'b@example.test', 'c@example.test'];
	let failFor: string | null = null;
	const services: SupportServices = {
		getDb: async () => client,
		audit: async (orgId, input) => {
			audits.push({
				orgId,
				action: input.action,
				...(input.detail ? { detail: input.detail } : {})
			});
		},
		ownerEmails: async () => owners,
		notify: async (to, summary, reviewPath) => {
			if (to === failFor) throw new Error('mail down');
			mails.push({ to, summary, reviewPath });
		},
		startOperation: async () => undefined,
		newId: () => `sg_${++n}`,
		now: () => now
	};
	return {
		client,
		raw,
		org,
		services,
		audits,
		mails,
		advance: (ms: number) => void (now += ms),
		failFor: (to: string) => void (failFor = to),
		now: () => now
	};
}

describe('support grants', () => {
	it('records a grant with its scope, end and an audit row in the organization', async () => {
		const w = await world();
		const grant = await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 48,
			reason: 'Help with the migration'
		});
		expect(grant).toMatchObject({ scope: 'act', live: true, revokedAt: null });
		expect(grant.expiresAt - grant.createdAt).toBe(48 * HOUR);
		expect(w.audits).toEqual([
			{
				orgId: w.org.id,
				action: 'support.grant.create',
				detail: { scope: 'act', expiresAt: grant.expiresAt }
			}
		]);
	});

	it('refuses a grant shorter than an hour or longer than seven days', async () => {
		const w = await world();
		const make = (hours: number) =>
			createGrant(w.services, {
				orgId: w.org.id,
				principal: OWNER,
				scope: 'read-metadata',
				hours,
				reason: 'x'
			});
		await expect(make(0)).rejects.toMatchObject({ details: { reason: 'grant_length' } });
		await expect(make(SUPPORT_GRANT_MAX_MS / HOUR + 1)).rejects.toMatchObject({
			details: { reason: 'grant_length' }
		});
		await expect(make(SUPPORT_GRANT_MAX_MS / HOUR)).resolves.toMatchObject({ live: true });
	});

	it('revokes once, audits once, and answers a second revoke without another row', async () => {
		const w = await world();
		const grant = await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 2,
			reason: 'x'
		});
		const first = await revokeGrant(w.services, {
			orgId: w.org.id,
			id: grant.id,
			principal: OWNER
		});
		expect(first).toMatchObject({ live: false });
		expect(first.revokedAt).not.toBeNull();
		await revokeGrant(w.services, { orgId: w.org.id, id: grant.id, principal: OWNER });
		expect(w.audits.filter((a) => a.action === 'support.grant.revoke')).toHaveLength(1);
		await expect(
			revokeGrant(w.services, { orgId: w.org.id, id: 'sg_none', principal: OWNER })
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			revokeGrant(w.services, { orgId: 'org_other', id: grant.id, principal: OWNER })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('marks a grant as ended once its time is up', async () => {
		const w = await world();
		await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 1,
			reason: 'x'
		});
		w.advance(2 * HOUR);
		expect((await listOrgGrants(w.services, w.org.id))[0]).toMatchObject({ live: false });
		expect((await listAdminGrants(w.services)).grants).toEqual([]);
	});
});

describe('break-glass access', () => {
	it('opens an hour, tells every owner at once and writes both audit rows with the reason', async () => {
		const w = await world();
		const view = await startBreakGlass(w.services, {
			orgId: w.org.id,
			reason: 'Site down and the owner is unreachable',
			principal: ADMIN
		});
		expect(view.expiresAt - view.startedAt).toBe(BREAK_GLASS_MS);
		expect(view.ownersNotified).toBe(3);
		expect(w.mails.map((m) => m.to).sort()).toEqual([
			'a@example.test',
			'b@example.test',
			'c@example.test'
		]);
		expect(w.mails.every((m) => m.reviewPath === '/org/support')).toBe(true);
		expect(w.mails[0]?.summary).toContain('Site down and the owner is unreachable');
		expect(w.audits[0]).toMatchObject({
			orgId: w.org.id,
			action: 'support.break-glass.start',
			detail: { reason: 'Site down and the owner is unreachable' }
		});
		const platform = await listPlatformAudit(w.client);
		expect(platform[0]).toMatchObject({
			action: 'admin.break-glass.start',
			target: w.org.id,
			detail: { reason: 'Site down and the owner is unreachable' }
		});
	});

	it('refuses an empty reason, an unknown organization and a key principal', async () => {
		const w = await world();
		await expect(
			startBreakGlass(w.services, { orgId: w.org.id, reason: '   ', principal: ADMIN })
		).rejects.toMatchObject({ details: { reason: 'reason_required' } });
		await expect(
			startBreakGlass(w.services, {
				orgId: 'org_none',
				reason: 'a good reason',
				principal: ADMIN
			})
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			startBreakGlass(w.services, {
				orgId: w.org.id,
				reason: 'a good reason',
				principal: { kind: 'key', keyId: 'k', issuerId: 'u' }
			})
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(w.mails).toEqual([]);
	});

	it('keeps the access and counts only the mails that went out when one owner cannot be reached', async () => {
		const w = await world();
		w.failFor('b@example.test');
		const view = await startBreakGlass(w.services, {
			orgId: w.org.id,
			reason: 'Site down and the owner is unreachable',
			principal: ADMIN
		});
		expect(view.ownersNotified).toBe(2);
		expect(view.live).toBe(true);
	});

	it('rate limits one admin per day and frees them once the day has passed', async () => {
		const w = await world();
		const start = () =>
			startBreakGlass(w.services, {
				orgId: w.org.id,
				reason: 'Site down and the owner is unreachable',
				principal: ADMIN
			});
		for (let i = 0; i < BREAK_GLASS_MAX_PER_DAY; i++) await start();
		await expect(start()).rejects.toMatchObject({
			code: 'rate_limited',
			details: { reason: 'break_glass_rate' }
		});
		await expect(
			startBreakGlass(w.services, {
				orgId: w.org.id,
				reason: 'Site down and the owner is unreachable',
				principal: { kind: 'user', userId: 'usr_other_admin' }
			})
		).resolves.toMatchObject({ live: true });
		w.advance(25 * HOUR);
		await expect(start()).resolves.toMatchObject({ live: true });
	});
});

describe('the standing the facts loader reads', () => {
	const platformFor =
		(admin: string | null) =>
		async ({ userId }: { userId: string }) =>
			userId === admin
				? { admin: true, access: true, permissions: ['read', 'support'] as const }
				: null;

	it('gives a platform admin the live grant as the role it maps to', async () => {
		const w = await world();
		await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'read-metadata',
			hours: 4,
			reason: 'x'
		});
		const port = supportStanding(
			async () => w.client,
			platformFor(ADMIN.userId) as never,
			w.now
		);
		const standing = await port({
			userId: ADMIN.userId,
			orgId: w.org.id,
			access: { email: 'a@b.c' }
		});
		expect(standing?.supportGrant).toMatchObject({ orgId: w.org.id, role: 'viewer' });
		expect(standing?.breakGlass).toBeUndefined();
	});

	it('gives a person with no platform role nothing, even beside a live grant', async () => {
		const w = await world();
		await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 4,
			reason: 'x'
		});
		const port = supportStanding(
			async () => w.client,
			platformFor(ADMIN.userId) as never,
			w.now
		);
		expect(await port({ userId: 'usr_someone', orgId: w.org.id, access: null })).toBeNull();
	});

	it('drops a revoked grant and a lapsed break-glass window', async () => {
		const w = await world();
		const grant = await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 4,
			reason: 'x'
		});
		await revokeGrant(w.services, { orgId: w.org.id, id: grant.id, principal: OWNER });
		await startBreakGlass(w.services, {
			orgId: w.org.id,
			reason: 'Site down and the owner is unreachable',
			principal: ADMIN
		});
		const port = supportStanding(
			async () => w.client,
			platformFor(ADMIN.userId) as never,
			w.now
		);
		const open = await port({
			userId: ADMIN.userId,
			orgId: w.org.id,
			access: { email: 'a@b.c' }
		});
		expect(open?.supportGrant).toBeUndefined();
		expect(open?.breakGlass).toMatchObject({ orgId: w.org.id });
		w.advance(BREAK_GLASS_MS + 1);
		const lapsed = await port({
			userId: ADMIN.userId,
			orgId: w.org.id,
			access: { email: 'a@b.c' }
		});
		expect(lapsed?.breakGlass).toBeUndefined();
	});
});

describe('the facts a support grant produces', () => {
	const store: FactsStore = {
		organization: async (id) => ({ id }),
		site: async () => null,
		member: async () => null,
		siteGrants: async () => [],
		delegations: async () => []
	};
	const platform = async () => ({
		admin: true,
		access: true,
		permissions: ['read', 'support'] as const
	});
	// the loader reads the clock itself, so the clock follows the world's
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());
	const load = (w: Awaited<ReturnType<typeof world>>) => {
		vi.setSystemTime(w.now());
		return loadFacts(
			{
				store,
				platform: platform as never,
				support: supportStanding(async () => w.client, platform as never, w.now)
			},
			{
				principal: ADMIN,
				scope: 'organization',
				action: 'org.read',
				params: { orgId: w.org.id },
				access: { email: 'a@b.c' }
			}
		);
	};

	it('shows the organization to an admin with a live grant and hides it without one', async () => {
		const w = await world();
		expect(await load(w)).toBeNull();
		const grant = await createGrant(w.services, {
			orgId: w.org.id,
			principal: OWNER,
			scope: 'act',
			hours: 1,
			reason: 'x'
		});
		expect((await load(w))?.facts.supportGrant).toMatchObject({ role: 'developer' });
		w.advance(2 * HOUR);
		expect(await load(w)).toBeNull();
		await revokeGrant(w.services, { orgId: w.org.id, id: grant.id, principal: OWNER });
		expect(await load(w)).toBeNull();
	});

	it('shows the organization to an admin inside a break-glass hour only', async () => {
		const w = await world();
		await startBreakGlass(w.services, {
			orgId: w.org.id,
			reason: 'Site down and the owner is unreachable',
			principal: ADMIN
		});
		expect((await load(w))?.facts.breakGlass).toMatchObject({ orgId: w.org.id });
		w.advance(BREAK_GLASS_MS + 1);
		expect(await load(w)).toBeNull();
	});
});

describe('the audit of a use of support access', () => {
	const record = (via: 'support-grant' | 'break-glass' | 'organisation', orgId: string) => ({
		requestId: 'req_1',
		principal: ADMIN,
		action: 'org.read' as const,
		via,
		orgIds: [orgId],
		resource: { orgId },
		method: 'GET',
		path: `/api/v1/orgs/${orgId}`
	});

	it.each(['support-grant', 'break-glass'] as const)(
		'writes a %s use to the organization chain and to the platform audit',
		async (via) => {
			const { client, raw } = sqliteClient();
			const writers = auditWriters(async () => client, memoryHeads());
			await writers.audit(record(via, 'org_1'));
			expect(raw.prepare('SELECT action, organization_id FROM audit_log').all()).toEqual([
				{ action: 'org.read', organization_id: 'org_1' }
			]);
			const platform = await listPlatformAudit(client);
			expect(platform).toHaveLength(1);
			expect(platform[0]).toMatchObject({
				action: 'org.read',
				target: 'org_1',
				detail: { via, organizationIds: ['org_1'] }
			});
		}
	);

	it('leaves the platform audit alone for a normal member', async () => {
		const { client } = sqliteClient();
		const writers = auditWriters(async () => client, memoryHeads());
		await writers.audit(record('organisation', 'org_1'));
		expect(await listPlatformAudit(client)).toEqual([]);
	});
});
