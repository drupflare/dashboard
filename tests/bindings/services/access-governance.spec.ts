import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { insertDepartment, insertDepartmentMember } from '../../../src/server/db/repos/departments';
import { createUser } from '../../../src/server/db/repos/identity';
import {
	addMember,
	createApiKey,
	createDelegation,
	createInvite,
	createOrganization,
	createSiteGrant,
	getMember,
	removeMember,
	setMemberRole
} from '../../../src/server/db/repos/organization';
import { authorize, type Facts } from '../../../src/server/domain/authorize';
import {
	closeReview,
	createReview,
	decideItem,
	getReviewSchedule,
	listReviews,
	reviewDetail,
	reviewEvidence,
	runScheduledReviews,
	setReviewSchedule,
	staleCredentials
} from '../../../src/server/services/access-reviews';
import { sha256Hex } from '../../../src/server/services/crypto';
import { collegeFactsStore, loadFacts } from '../../../src/server/services/facts';
import type { GovernanceActor, GovernanceServices } from '../../../src/server/services/governance';
import { offboardMember } from '../../../src/server/services/offboarding';
import { getOrgSettings, setOrgSettings } from '../../../src/server/services/org-settings';
import {
	createServiceAccount,
	disableServiceAccount,
	issueAccountKey,
	listKeysOfAccount
} from '../../../src/server/services/service-accounts';
import { DAY_MS } from '../../../src/shared/access-reviews';
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

async function factsOf(orgId: string, userId: string): Promise<Facts | null> {
	const loaded = await loadFacts(
		{ store: collegeFactsStore(async () => db) },
		{
			principal: { kind: 'user', userId },
			scope: 'organization',
			action: 'key.create',
			params: { orgId }
		}
	);
	return loaded?.facts ?? null;
}

async function actorOf(orgId: string, userId: string): Promise<GovernanceActor> {
	return {
		principal: { kind: 'user', userId },
		userId,
		facts: (await factsOf(orgId, userId))!
	};
}

function governance(clock: { t: number } = { t: Date.now() }) {
	const trail: { orgId: string; action: string; target: string }[] = [];
	const mail = vi.fn(async () => ({ sent: 0, skipped: 2 }));
	const deps: GovernanceServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, action: input.action, target: input.target });
		},
		now: () => clock.t,
		newId: () => crypto.randomUUID(),
		ownerFacts: factsOf,
		reviewMail: mail
	};
	return { deps, trail, mail, clock };
}

async function organisation() {
	const owner = await createUser(db, { email: email('owner') });
	const org = await createOrganization(db, {
		name: 'Governance Test',
		personal: false,
		createdBy: owner.id
	});
	const ownerMember = await addMember(db, org.id, { userId: owner.id, role: 'owner' });
	const person = async (role: 'owner' | 'admin' | 'developer' | 'viewer') => {
		const user = await createUser(db, { email: email(role) });
		const member = await addMember(db, org.id, { userId: user.id, role });
		return { user, member };
	};
	return { orgId: org.id, owner, ownerMember, person };
}

describe('service accounts', () => {
	it('needs an owner who is a member and an expiry of at most a year', async () => {
		const { deps } = governance();
		const { orgId, owner } = await organisation();
		const actor = await actorOf(orgId, owner.id);
		const stranger = await createUser(db, { email: email('stranger') });
		await expect(
			createServiceAccount(deps, orgId, actor, {
				name: 'Bot',
				ownerUserId: stranger.id,
				expiresInDays: 30
			})
		).rejects.toMatchObject({ code: 'validation' });
		await expect(
			createServiceAccount(deps, orgId, actor, { name: 'Bot', expiresInDays: 366 })
		).rejects.toMatchObject({ code: 'validation' });
		await expect(
			createServiceAccount(deps, orgId, actor, { name: 'Bot', expiresInDays: 0 })
		).rejects.toMatchObject({ code: 'validation' });
		const made = await createServiceAccount(deps, orgId, actor, {
			name: 'Deploy Bot',
			expiresInDays: 365
		});
		expect(made).toMatchObject({ state: 'active', ownerUserId: owner.id, keyCount: 0 });
	});

	it('is refused to a developer', async () => {
		const { deps } = governance();
		const { orgId, person } = await organisation();
		const dev = await person('developer');
		await expect(
			createServiceAccount(deps, orgId, await actorOf(orgId, dev.user.id), {
				name: 'Bot',
				expiresInDays: 30
			})
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('gives a key no more than the owner holds and no longer life than the account', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const dev = await person('developer');
		const actor = await actorOf(orgId, owner.id);
		const account = await createServiceAccount(deps, orgId, actor, {
			name: 'CI',
			ownerUserId: dev.user.id,
			expiresInDays: 30
		});
		await expect(
			issueAccountKey(deps, orgId, actor, account.id, {
				name: 'too much',
				scopes: ['member.invite'],
				expiry: '90d'
			})
		).rejects.toMatchObject({ code: 'forbidden' });
		const key = await issueAccountKey(deps, orgId, actor, account.id, {
			name: 'ci',
			scopes: ['key.read'],
			expiry: '365d'
		});
		expect(Date.parse(key.expiresAt!)).toBe(Date.parse(account.expiresAt));
		const row = await db.first<{ created_by: string }>(
			orgId,
			'SELECT created_by FROM api_keys WHERE id = ?',
			[key.id]
		);
		expect(row?.created_by).toBe(dev.user.id);
		expect((await listKeysOfAccount(deps, orgId, actor, account.id)).items).toHaveLength(1);
	});

	it('stops a key when its owner loses the permission or leaves', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const dev = await person('developer');
		const actor = await actorOf(orgId, owner.id);
		const account = await createServiceAccount(deps, orgId, actor, {
			name: 'CI',
			ownerUserId: dev.user.id,
			expiresInDays: 30
		});
		const key = await issueAccountKey(deps, orgId, actor, account.id, {
			name: 'ci',
			scopes: ['key.read'],
			expiry: '30d'
		});
		const use = async () => {
			const facts = await factsOf(orgId, dev.user.id);
			if (facts === null) return false;
			return authorize({
				principal: { kind: 'key', keyId: key.id, issuerId: dev.user.id },
				action: 'key.read',
				resource: { orgId },
				facts: { ...facts, key: { id: key.id, scopes: ['key.read'] } }
			}).allow;
		};
		expect(await use()).toBe(true);
		await setMemberRole(db, orgId, dev.member.id, 'viewer');
		expect(await use()).toBe(false);
		await removeMember(db, orgId, dev.member.id);
		expect(await factsOf(orgId, dev.user.id)).toBeNull();
	});

	it('revokes every key when disabled and refuses new ones', async () => {
		const { deps } = governance();
		const { orgId, owner } = await organisation();
		const actor = await actorOf(orgId, owner.id);
		const account = await createServiceAccount(deps, orgId, actor, {
			name: 'Old',
			expiresInDays: 30
		});
		await issueAccountKey(deps, orgId, actor, account.id, {
			name: 'k',
			scopes: ['key.read'],
			expiry: '30d'
		});
		const off = await disableServiceAccount(deps, orgId, actor, account.id);
		expect(off).toMatchObject({ state: 'disabled', keyCount: 0 });
		await expect(
			issueAccountKey(deps, orgId, actor, account.id, {
				name: 'k2',
				scopes: ['key.read'],
				expiry: '30d'
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('refuses a key once the account has expired', async () => {
		const { deps, clock } = governance();
		const { orgId, owner } = await organisation();
		const actor = await actorOf(orgId, owner.id);
		const account = await createServiceAccount(deps, orgId, actor, {
			name: 'Short',
			expiresInDays: 1
		});
		clock.t += 2 * DAY_MS;
		await expect(
			issueAccountKey(deps, orgId, actor, account.id, {
				name: 'late',
				scopes: ['key.read'],
				expiry: '30d'
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});
});

describe('access reviews', () => {
	it('snapshots the subjects and ignores later changes', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const dev = await person('developer');
		const actor = await actorOf(orgId, owner.id);
		const review = await createReview(deps, orgId, actor, { scope: 'organization' });
		expect(review).toMatchObject({ state: 'open', total: 2, pending: 2 });
		await person('viewer');
		await removeMember(db, orgId, dev.member.id);
		const detail = await reviewDetail(deps, orgId, owner.id, review.id);
		expect(detail.items).toHaveLength(2);
		expect(detail.items.map((item) => item.kind)).toEqual(['member', 'member']);
	});

	it('refuses a decision about yourself and lets someone else decide', async () => {
		const { deps } = governance();
		const { orgId, owner, ownerMember, person } = await organisation();
		const second = await person('owner');
		const review = await createReview(deps, orgId, await actorOf(orgId, owner.id), {
			scope: 'organization'
		});
		const own = {
			kind: 'member' as const,
			subjectRef: ownerMember.id,
			decision: 'keep' as const
		};
		await expect(
			decideItem(deps, orgId, await actorOf(orgId, owner.id), review.id, own)
		).rejects.toMatchObject({ code: 'forbidden' });
		const detail = await reviewDetail(deps, orgId, owner.id, review.id);
		expect(detail.items.find((item) => item.subjectRef === ownerMember.id)?.own).toBe(true);
		await expect(
			decideItem(deps, orgId, await actorOf(orgId, second.user.id), review.id, own)
		).resolves.toMatchObject({ decision: 'keep' });
	});

	it('applies a removal only when the review closes, and refuses to close with items waiting', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const dev = await person('developer');
		const second = await person('owner');
		const key = await createApiKey(db, orgId, {
			name: 'old key',
			keyHash: crypto.randomUUID(),
			scopes: ['key.read'],
			createdBy: dev.user.id,
			expiresAt: null
		});
		const grant = await createSiteGrant(db, orgId, {
			siteId: 'site-x',
			userId: dev.user.id,
			role: 'viewer',
			createdBy: owner.id
		});
		const actor = await actorOf(orgId, owner.id);
		const other = await actorOf(orgId, second.user.id);
		const review = await createReview(deps, orgId, actor, { scope: 'organization' });
		await expect(closeReview(deps, orgId, actor, review.id)).rejects.toMatchObject({
			code: 'conflict'
		});
		const pick = (
			who: GovernanceActor,
			kind: 'member' | 'grant' | 'api-key',
			ref: string,
			decision: 'keep' | 'revoke'
		) => decideItem(deps, orgId, who, review.id, { kind, subjectRef: ref, decision });
		await pick(actor, 'grant', grant.id, 'revoke');
		await pick(actor, 'api-key', key.id, 'revoke');
		await pick(actor, 'member', dev.member.id, 'revoke');
		await pick(actor, 'member', second.member.id, 'keep');
		const ownerItem = (await reviewDetail(deps, orgId, owner.id, review.id)).items.find(
			(item) => item.own
		)!;
		await pick(other, 'member', ownerItem.subjectRef, 'keep');
		expect(await getMember(db, orgId, dev.user.id)).not.toBeNull();

		const closed = await closeReview(deps, orgId, actor, review.id);
		expect(closed).toMatchObject({ applied: 3, failed: 0 });
		expect(closed.review.state).toBe('closed');
		expect(await getMember(db, orgId, dev.user.id)).toBeNull();
		const keyRow = await db.first<{ revoked_at: number | null }>(
			orgId,
			'SELECT revoked_at FROM api_keys WHERE id = ?',
			[key.id]
		);
		expect(keyRow?.revoked_at).not.toBeNull();
		const grantRow = await db.first<{ revoked_at: number | null }>(
			orgId,
			'SELECT revoked_at FROM site_grants WHERE id = ?',
			[grant.id]
		);
		expect(grantRow?.revoked_at).not.toBeNull();
	});

	it('applies right away when asked and keeps a failure on the item', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const second = await person('owner');
		const actor = await actorOf(orgId, owner.id);
		const review = await createReview(deps, orgId, actor, { scope: 'organization' });
		const item = await decideItem(deps, orgId, actor, review.id, {
			kind: 'member',
			subjectRef: second.member.id,
			decision: 'revoke',
			applyNow: true
		});
		expect(item.appliedAt).not.toBeNull();
		expect(await getMember(db, orgId, second.user.id)).toBeNull();

		// the last owner cannot be removed, and the item says why
		const ownerRef = (await reviewDetail(deps, orgId, owner.id, review.id)).items.find(
			(i) => i.own
		)!.subjectRef;
		const other = await person('admin');
		const asAdmin = await actorOf(orgId, other.user.id);
		const refused = await decideItem(deps, orgId, asAdmin, review.id, {
			kind: 'member',
			subjectRef: ownerRef,
			decision: 'revoke',
			applyNow: true
		});
		expect(refused.appliedAt).toBeNull();
		expect(refused.applyError).toBeTruthy();
		expect(await getMember(db, orgId, owner.id)).not.toBeNull();
	});

	it('lists stale keys and accounts, with a never-used one counted from its start', async () => {
		const { deps, clock } = governance();
		const { orgId, owner } = await organisation();
		const make = (name: string) =>
			createApiKey(db, orgId, {
				name,
				keyHash: crypto.randomUUID(),
				scopes: ['key.read'],
				createdBy: owner.id,
				expiresAt: null
			});
		const old = await make('old');
		const fresh = await make('fresh');
		const never = await make('never');
		const set = (id: string, used: number | null, created: number) =>
			db.run(orgId, 'UPDATE api_keys SET last_used_at = ?, created_at = ? WHERE id = ?', [
				used,
				created,
				id
			]);
		await set(old.id, clock.t - 100 * DAY_MS, clock.t - 200 * DAY_MS);
		await set(fresh.id, clock.t - 10 * DAY_MS, clock.t - 200 * DAY_MS);
		await set(never.id, null, clock.t - 120 * DAY_MS);
		const report = await staleCredentials(deps, orgId);
		const names = report.items.map((row) => row.label);
		expect(names.some((n) => n.startsWith('old '))).toBe(true);
		expect(names.some((n) => n.startsWith('never '))).toBe(true);
		expect(names.some((n) => n.startsWith('fresh '))).toBe(false);
		expect(report.items.find((row) => row.label.startsWith('never '))?.lastUsedAt).toBeNull();
	});

	it('exports a closed review with the formula escape and a matching hash', async () => {
		const { deps } = governance();
		const { orgId, owner, person } = await organisation();
		const second = await person('owner');
		await createApiKey(db, orgId, {
			name: '=HYPERLINK("x")',
			keyHash: crypto.randomUUID(),
			scopes: ['key.read'],
			createdBy: owner.id,
			expiresAt: null
		});
		const actor = await actorOf(orgId, owner.id);
		const other = await actorOf(orgId, second.user.id);
		const review = await createReview(deps, orgId, actor, { scope: 'organization' });
		await expect(reviewEvidence(deps, orgId, review.id)).rejects.toMatchObject({
			code: 'conflict'
		});
		const items = (await reviewDetail(deps, orgId, owner.id, review.id)).items;
		for (const item of items) {
			await decideItem(deps, orgId, item.own ? other : actor, review.id, {
				kind: item.kind,
				subjectRef: item.subjectRef,
				decision: 'keep',
				reason: '=SUM(1)'
			});
		}
		await closeReview(deps, orgId, actor, review.id);
		const { json, csv } = await reviewEvidence(deps, orgId, review.id);
		expect(csv).toContain(`'=HYPERLINK`);
		expect(csv).toContain(`'=SUM(1)`);
		expect(json.sha256).toBe(await sha256Hex(csv));
		expect(json.items).toHaveLength(items.length);
	});

	it('opens a review on the interval with a fake clock and mails the reviewers once', async () => {
		const { deps, clock, mail } = governance();
		const { orgId, owner } = await organisation();
		await setReviewSchedule(deps, orgId, await actorOf(orgId, owner.id), 'quarterly');
		const mine = (r: { opened: string[] }) => r.opened.length;
		clock.t += 30 * DAY_MS;
		expect(mine(await runScheduledReviews(deps))).toBe(0);
		clock.t += 62 * DAY_MS;
		const first = await runScheduledReviews(deps);
		expect(first.opened).toHaveLength(1);
		expect(mail).toHaveBeenCalledTimes(1);
		expect(first.skipped).toBe(2);
		expect((await getReviewSchedule(deps, orgId)).lastOpenedAt).not.toBeNull();
		clock.t += 92 * DAY_MS;
		expect(mine(await runScheduledReviews(deps))).toBe(0);
		await db.run(orgId, `UPDATE access_reviews SET state = 'closed' WHERE id = ?`, [
			first.opened[0]
		]);
		clock.t += 1 * DAY_MS;
		expect(mine(await runScheduledReviews(deps))).toBe(1);
	});

	it('leaves an organization with the interval off alone', async () => {
		const { deps, clock } = governance();
		const { orgId, owner } = await organisation();
		await setReviewSchedule(deps, orgId, await actorOf(orgId, owner.id), 'off');
		clock.t += 400 * DAY_MS;
		const result = await runScheduledReviews(deps);
		expect(result.opened).not.toContain(orgId);
	});
});

describe('offboarding', () => {
	async function crowded() {
		const g = governance();
		const { orgId, owner, person } = await organisation();
		const leaver = await person('developer');
		const heir = await person('developer');
		const actor = await actorOf(orgId, owner.id);
		const account = await createServiceAccount(g.deps, orgId, actor, {
			name: 'Leaver Bot',
			ownerUserId: leaver.user.id,
			expiresInDays: 60
		});
		const accountKey = await issueAccountKey(g.deps, orgId, actor, account.id, {
			name: 'bot key',
			scopes: ['key.read'],
			expiry: '30d'
		});
		const personal = await createApiKey(db, orgId, {
			name: 'personal',
			keyHash: crypto.randomUUID(),
			scopes: ['key.read'],
			createdBy: leaver.user.id,
			expiresAt: null
		});
		await createSiteGrant(db, orgId, {
			siteId: 'site-y',
			userId: leaver.user.id,
			role: 'viewer',
			createdBy: owner.id
		});
		await insertDepartment(db, {
			id: `d-${crypto.randomUUID()}`,
			organizationId: orgId,
			parentId: null,
			name: 'Library',
			kind: 'department',
			siteQuota: null,
			createdAt: 1
		});
		const dept = (await db.first<{ id: string }>(
			orgId,
			'SELECT id FROM departments WHERE organization_id = ?',
			[orgId]
		))!.id;
		await insertDepartmentMember(db, {
			organizationId: orgId,
			departmentId: dept,
			userId: leaver.user.id,
			role: 'viewer',
			grantedBy: owner.id,
			grantedAt: 1
		});
		await createInvite(db, orgId, {
			email: email('invitee'),
			role: 'viewer',
			tokenHash: crypto.randomUUID(),
			invitedBy: leaver.user.id,
			expiresAt: Date.now() + DAY_MS
		});
		const agency = await createOrganization(db, {
			name: 'Agency',
			personal: false,
			createdBy: owner.id
		});
		await createDelegation(db, orgId, {
			agencyOrganizationId: agency.id,
			role: 'viewer',
			siteId: null,
			createdBy: leaver.user.id,
			expiresAt: null
		});
		return { ...g, orgId, owner, leaver, heir, actor, account, accountKey, personal };
	}

	it('lists the same effects in a dry run as in the real run, and the dry run changes nothing', async () => {
		const w = await crowded();
		const dry = await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
			dryRun: true,
			transferTo: w.heir.user.id
		});
		expect(dry.dryRun).toBe(true);
		expect(await getMember(db, w.orgId, w.leaver.user.id)).not.toBeNull();
		const kinds = dry.effects.map((e) => e.kind).sort();
		expect(kinds).toEqual(
			[
				'api-key',
				'delegation',
				'department-role',
				'invite',
				'membership',
				'service-account-transfer',
				'site-grant'
			].sort()
		);
		const before = w.trail.length;
		const real = await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
			transferTo: w.heir.user.id
		});
		expect(real.effects).toEqual(dry.effects);
		expect(await getMember(db, w.orgId, w.leaver.user.id)).toBeNull();
		const rows = w.trail.slice(before).filter((row) => row.action.startsWith('offboard.'));
		expect(rows).toHaveLength(real.effects.length);
	});

	it('hands the service account and its keys to the new owner and revokes personal keys', async () => {
		const w = await crowded();
		await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
			transferTo: w.heir.user.id
		});
		const owner = await db.first<{ owner_user_id: string }>(
			w.orgId,
			'SELECT owner_user_id FROM service_accounts WHERE id = ?',
			[w.account.id]
		);
		expect(owner?.owner_user_id).toBe(w.heir.user.id);
		const botKey = await db.first<{ created_by: string; revoked_at: number | null }>(
			w.orgId,
			'SELECT created_by, revoked_at FROM api_keys WHERE id = ?',
			[w.accountKey.id]
		);
		expect(botKey).toEqual({ created_by: w.heir.user.id, revoked_at: null });
		const mine = await db.first<{ revoked_at: number | null }>(
			w.orgId,
			'SELECT revoked_at FROM api_keys WHERE id = ?',
			[w.personal.id]
		);
		expect(mine?.revoked_at).not.toBeNull();
		const invites = await db.first<{ n: number }>(
			w.orgId,
			`SELECT COUNT(*) AS n FROM invites WHERE organization_id = ? AND state = 'pending' AND invited_by = ?`,
			[w.orgId, w.leaver.user.id]
		);
		expect(invites?.n).toBe(0);
	});

	it('disables the service account when nobody takes it over', async () => {
		const w = await crowded();
		const result = await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id);
		expect(result.effects.map((e) => e.kind)).toContain('service-account-disable');
		const row = await db.first<{ disabled_at: number | null }>(
			w.orgId,
			'SELECT disabled_at FROM service_accounts WHERE id = ?',
			[w.account.id]
		);
		expect(row?.disabled_at).not.toBeNull();
		const key = await db.first<{ revoked_at: number | null }>(
			w.orgId,
			'SELECT revoked_at FROM api_keys WHERE id = ?',
			[w.accountKey.id]
		);
		expect(key?.revoked_at).not.toBeNull();
	});

	it('keeps the agency access the person created when an admin chooses', async () => {
		const w = await crowded();
		const result = await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
			keepDelegations: true
		});
		expect(result.kept.map((e) => e.kind)).toEqual(['delegation']);
		expect(result.effects.map((e) => e.kind)).not.toContain('delegation');
		const row = await db.first<{ state: string }>(
			w.orgId,
			'SELECT state FROM delegations WHERE organization_id = ?',
			[w.orgId]
		);
		expect(row?.state).toBe('pending');
	});

	it('settles open review items about the person', async () => {
		const w = await crowded();
		const review = await createReview(w.deps, w.orgId, w.actor, { scope: 'organization' });
		await offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
			transferTo: w.heir.user.id
		});
		const detail = await reviewDetail(w.deps, w.orgId, w.owner.id, review.id);
		const member = detail.items.find((i) => i.subjectRef === w.leaver.member.id);
		expect(detail.items.filter((i) => i.decidedBy === 'offboarding').length).toBeGreaterThan(0);
		const bot = detail.items.find((i) => i.kind === 'service-account')!;
		expect(bot.decision).toBe('pending');
		expect(bot.heldBy).toContain('developer');
		expect(member).toMatchObject({ decision: 'revoke', decidedBy: 'offboarding' });
	});

	it('refuses to offboard yourself, someone above you and the last owner', async () => {
		const w = await crowded();
		await expect(
			offboardMember(w.deps, w.orgId, w.actor, w.owner.id, { dryRun: true })
		).rejects.toMatchObject({ code: 'validation' });
		const admin = await actorOf(
			w.orgId,
			(
				await (async () => {
					const user = await createUser(db, { email: email('admin') });
					await addMember(db, w.orgId, { userId: user.id, role: 'admin' });
					return user;
				})()
			).id
		);
		await expect(
			offboardMember(w.deps, w.orgId, admin, w.owner.id, { dryRun: true })
		).rejects.toMatchObject({ code: 'forbidden' });
		// an actor who claims to be an owner while the only owner row is the target
		const forged: GovernanceActor = {
			...admin,
			facts: { ...admin.facts, membership: { orgId: w.orgId, role: 'owner' } }
		};
		await expect(
			offboardMember(w.deps, w.orgId, forged, w.owner.id, { dryRun: true })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('names a transferee who is not a member as not valid', async () => {
		const w = await crowded();
		const stranger = await createUser(db, { email: email('s') });
		await expect(
			offboardMember(w.deps, w.orgId, w.actor, w.leaver.user.id, {
				dryRun: true,
				transferTo: stranger.id
			})
		).rejects.toMatchObject({ code: 'validation' });
	});
});

describe('department admins and review items', () => {
	async function departmental() {
		const g = governance();
		const org = await organisation();
		const { orgId, owner } = org;
		const dept = async (name: string, parentId: string | null) => {
			const id = `d-${crypto.randomUUID()}`;
			await insertDepartment(db, {
				id,
				organizationId: orgId,
				parentId,
				name,
				kind: 'department',
				siteQuota: null,
				createdAt: 1
			});
			return id;
		};
		const a = await dept('Library', null);
		const a1 = await dept('Archives', a);
		const b = await dept('Athletics', null);
		const site = async (id: string, departmentId: string | null) => {
			await db.run(
				orgId,
				`INSERT INTO sites (id, organization_id, name, plane, state, department_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'managed', 'active', ?, 1, 1)`,
				[id, orgId, id, departmentId]
			);
		};
		const tag = crypto.randomUUID().slice(0, 8);
		const siteA1 = `site-a1-${tag}`;
		const siteB = `site-b-${tag}`;
		const siteNone = `site-none-${tag}`;
		await site(siteA1, a1);
		await site(siteB, b);
		await site(siteNone, null);
		const deptAdmin = await org.person('viewer');
		const bAdmin = await org.person('viewer');
		const deptDev = await org.person('viewer');
		const plain = await org.person('viewer');
		const developer = await org.person('developer');
		const role = (departmentId: string, userId: string, r: 'admin' | 'developer') =>
			insertDepartmentMember(db, {
				organizationId: orgId,
				departmentId,
				userId,
				role: r,
				grantedBy: owner.id,
				grantedAt: 1
			});
		await role(a, deptAdmin.user.id, 'admin');
		await role(b, bAdmin.user.id, 'admin');
		await role(a, deptDev.user.id, 'developer');
		const grant = (siteId: string, userId: string) =>
			createSiteGrant(db, orgId, { siteId, userId, role: 'viewer', createdBy: owner.id });
		const grantA1 = await grant(siteA1, plain.user.id);
		const grantB = await grant(siteB, plain.user.id);
		const grantNone = await grant(siteNone, plain.user.id);
		const agency = await createOrganization(db, {
			name: 'Agency',
			personal: false,
			createdBy: owner.id
		});
		const delegationA1 = await createDelegation(db, orgId, {
			agencyOrganizationId: agency.id,
			role: 'viewer',
			siteId: siteA1,
			createdBy: owner.id,
			expiresAt: null
		});
		const ownerActor = await actorOf(orgId, owner.id);
		const accountA1 = await createServiceAccount(g.deps, orgId, ownerActor, {
			name: 'Archive Bot',
			departmentId: a1,
			expiresInDays: 30
		});
		const accountNone = await createServiceAccount(g.deps, orgId, ownerActor, {
			name: 'Org Bot',
			expiresInDays: 30
		});
		const review = await createReview(g.deps, orgId, ownerActor, { scope: 'organization' });
		const as = (userId: string) => actorOf(orgId, userId);
		const decide = async (who: GovernanceActor, kind: string, subjectRef: string, extra = {}) =>
			decideItem(g.deps, orgId, who, review.id, {
				kind: kind as 'grant',
				subjectRef,
				decision: 'keep',
				...extra
			});
		const switchSetting = (on: boolean) =>
			setOrgSettings(g.deps, orgId, ownerActor, { departmentAdminsDecideReviews: on });
		return {
			...g,
			...org,
			a,
			a1,
			b,
			deptAdmin,
			bAdmin,
			deptDev,
			plain,
			developer,
			grantA1,
			grantB,
			grantNone,
			delegationA1,
			accountA1,
			accountNone,
			review,
			ownerActor,
			as,
			decide,
			switchSetting
		};
	}

	it('stamps each item with the department of its subject when the review opens', async () => {
		const w = await departmental();
		const rows = await db.all<{
			kind: string;
			subject_ref: string;
			department_id: string | null;
		}>(
			w.orgId,
			'SELECT kind, subject_ref, department_id FROM access_review_items WHERE review_id = ?',
			[w.review.id]
		);
		const of = (kind: string, ref: string) =>
			rows.results.find((r) => r.kind === kind && r.subject_ref === ref)?.department_id;
		expect(of('grant', w.grantA1.id)).toBe(w.a1);
		expect(of('grant', w.grantB.id)).toBe(w.b);
		expect(of('grant', w.grantNone.id)).toBeNull();
		expect(of('grant', `department:${w.a}:${w.deptAdmin.user.id}`)).toBe(w.a);
		expect(of('delegation', w.delegationA1.id)).toBe(w.a1);
		expect(of('service-account', w.accountA1.id)).toBe(w.a1);
		expect(of('service-account', w.accountNone.id)).toBeNull();
		expect(of('member', w.ownerMember.id)).toBeNull();
	});

	it('shows a department admin only the items inside their department subtree', async () => {
		const w = await departmental();
		const viewer = await w.as(w.deptAdmin.user.id);
		const detail = await reviewDetail(w.deps, w.orgId, viewer.userId, w.review.id, viewer);
		expect(detail.limited).toBe(true);
		expect(detail.items.map((item) => item.subjectRef).sort()).toEqual(
			[
				w.grantA1.id,
				w.delegationA1.id,
				w.accountA1.id,
				`department:${w.a}:${w.deptAdmin.user.id}`,
				`department:${w.a}:${w.deptDev.user.id}`
			].sort()
		);
		expect(detail.total).toBe(5);
		const list = await listReviews(w.deps, w.orgId, viewer);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ total: 5 });
		const other = await w.as(w.bAdmin.user.id);
		const theirs = await reviewDetail(w.deps, w.orgId, other.userId, w.review.id, other);
		expect(theirs.items.map((item) => item.subjectRef)).toContain(w.grantB.id);
		expect(theirs.items.map((item) => item.subjectRef)).not.toContain(w.grantA1.id);
	});

	it('gives an owner and an admin the whole review', async () => {
		const w = await departmental();
		const detail = await reviewDetail(w.deps, w.orgId, w.owner.id, w.review.id, w.ownerActor);
		expect(detail.limited).toBe(false);
		expect(detail.total).toBe(w.review.total);
		const admin = await w.person('admin');
		const adminActor = await w.as(admin.user.id);
		expect((await listReviews(w.deps, w.orgId, adminActor))[0]).toMatchObject({
			total: w.review.total
		});
	});

	it('lets a department admin decide an item in their subtree, including a child department', async () => {
		const w = await departmental();
		const who = await w.as(w.deptAdmin.user.id);
		await expect(w.decide(who, 'grant', w.grantA1.id)).resolves.toMatchObject({
			decision: 'keep'
		});
		await expect(w.decide(who, 'service-account', w.accountA1.id)).resolves.toMatchObject({
			decision: 'keep'
		});
		await expect(w.decide(who, 'delegation', w.delegationA1.id)).resolves.toMatchObject({
			decision: 'keep'
		});
		expect(w.trail.some((row) => row.action === 'access-review.decided')).toBe(true);
	});

	it('answers an item of another department, an organization item and a missing item alike', async () => {
		const w = await departmental();
		const who = await w.as(w.deptAdmin.user.id);
		for (const [kind, ref] of [
			['grant', w.grantB.id],
			['grant', w.grantNone.id],
			['service-account', w.accountNone.id],
			['member', w.ownerMember.id],
			['grant', 'nothing-here']
		] as const) {
			await expect(w.decide(who, kind, ref)).rejects.toMatchObject({ code: 'not_found' });
		}
		const other = await w.as(w.bAdmin.user.id);
		await expect(w.decide(other, 'grant', w.grantA1.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('refuses a department admin a decision about themselves', async () => {
		const w = await departmental();
		const who = await w.as(w.deptAdmin.user.id);
		await expect(
			w.decide(who, 'grant', `department:${w.a}:${w.deptAdmin.user.id}`)
		).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'own_item' } });
		const peer = await w.as(w.owner.id);
		await expect(
			w.decide(peer, 'grant', `department:${w.a}:${w.deptAdmin.user.id}`)
		).resolves.toMatchObject({ decision: 'keep' });
	});

	it('stops new decisions from department admins when the setting is off and keeps old ones', async () => {
		const w = await departmental();
		const who = await w.as(w.deptAdmin.user.id);
		await w.decide(who, 'grant', w.grantA1.id, { decision: 'revoke' });
		await w.switchSetting(false);
		await expect(w.decide(who, 'service-account', w.accountA1.id)).rejects.toMatchObject({
			code: 'forbidden',
			details: { reason: 'department_decisions_off' }
		});
		const detail = await reviewDetail(w.deps, w.orgId, w.owner.id, w.review.id, w.ownerActor);
		expect(detail.items.find((item) => item.subjectRef === w.grantA1.id)).toMatchObject({
			decision: 'revoke'
		});
		await expect(
			reviewDetail(w.deps, w.orgId, who.userId, w.review.id, who)
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await listReviews(w.deps, w.orgId, who)).toEqual([]);
		await expect(w.decide(w.ownerActor, 'grant', w.grantNone.id)).resolves.toMatchObject({
			decision: 'keep'
		});
		await w.switchSetting(true);
		await expect(w.decide(who, 'service-account', w.accountA1.id)).resolves.toMatchObject({
			decision: 'keep'
		});
	});

	it('keeps an organization admin deciding everywhere while the setting is off', async () => {
		const w = await departmental();
		await w.switchSetting(false);
		const admin = await w.person('admin');
		const who = await w.as(admin.user.id);
		await expect(w.decide(who, 'grant', w.grantB.id)).resolves.toMatchObject({
			decision: 'keep'
		});
		await expect(w.decide(who, 'member', w.ownerMember.id)).resolves.toMatchObject({
			decision: 'keep'
		});
	});

	it('gives a viewer, a developer and a department developer no way in', async () => {
		const w = await departmental();
		for (const user of [w.plain.user, w.developer.user, w.deptDev.user]) {
			const who = await w.as(user.id);
			await expect(listReviews(w.deps, w.orgId, who)).rejects.toMatchObject({
				code: 'forbidden'
			});
			await expect(
				reviewDetail(w.deps, w.orgId, who.userId, w.review.id, who)
			).rejects.toMatchObject({ code: 'forbidden' });
			await expect(w.decide(who, 'grant', w.grantA1.id)).rejects.toMatchObject({
				code: 'not_found'
			});
		}
	});

	it('leaves applying a removal now to an owner or admin', async () => {
		const w = await departmental();
		const who = await w.as(w.deptAdmin.user.id);
		await expect(
			w.decide(who, 'grant', w.grantA1.id, { decision: 'revoke', applyNow: true })
		).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'apply_needs_admin' } });
		await expect(
			w.decide(w.ownerActor, 'grant', w.grantA1.id, { decision: 'revoke', applyNow: true })
		).resolves.toMatchObject({ decision: 'revoke' });
	});

	it('stops a former department admin once the role is removed', async () => {
		const w = await departmental();
		await db.run(
			w.orgId,
			'DELETE FROM department_members WHERE organization_id = ? AND user_id = ?',
			[w.orgId, w.deptAdmin.user.id]
		);
		const who = await w.as(w.deptAdmin.user.id);
		await expect(w.decide(who, 'grant', w.grantA1.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});
});

describe('organization settings', () => {
	it('defaults to on, changes, and writes an audit row with the old and new value', async () => {
		const g = governance();
		const { orgId, owner } = await organisation();
		const actor = await actorOf(orgId, owner.id);
		expect(await getOrgSettings(g.deps, orgId)).toEqual({
			departmentAdminsDecideReviews: true
		});
		await setOrgSettings(g.deps, orgId, actor, { departmentAdminsDecideReviews: false });
		expect(await getOrgSettings(g.deps, orgId)).toEqual({
			departmentAdminsDecideReviews: false
		});
		expect(g.trail.at(-1)).toMatchObject({ action: 'org.settings.updated', target: orgId });
		await setOrgSettings(g.deps, orgId, actor, { departmentAdminsDecideReviews: true });
		expect(await getOrgSettings(g.deps, orgId)).toEqual({
			departmentAdminsDecideReviews: true
		});
	});

	it('is kept per organization', async () => {
		const g = governance();
		const one = await organisation();
		const two = await organisation();
		await setOrgSettings(g.deps, one.orgId, await actorOf(one.orgId, one.owner.id), {
			departmentAdminsDecideReviews: false
		});
		expect(await getOrgSettings(g.deps, two.orgId)).toEqual({
			departmentAdminsDecideReviews: true
		});
	});
});
