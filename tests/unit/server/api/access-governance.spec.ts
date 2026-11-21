import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import offboard from '../../../../src/server/api/v1/orgs/[orgId]/members/[memberId]/offboard.post';
import reviewClose from '../../../../src/server/api/v1/orgs/[orgId]/reviews/[reviewId]/close.post';
import reviewDecide from '../../../../src/server/api/v1/orgs/[orgId]/reviews/[reviewId]/decisions.post';
import reviewEvidence from '../../../../src/server/api/v1/orgs/[orgId]/reviews/[reviewId]/evidence.get';
import reviewGet from '../../../../src/server/api/v1/orgs/[orgId]/reviews/[reviewId]/index.get';
import reviewList from '../../../../src/server/api/v1/orgs/[orgId]/reviews/index.get';
import reviewCreate from '../../../../src/server/api/v1/orgs/[orgId]/reviews/index.post';
import scheduleGet from '../../../../src/server/api/v1/orgs/[orgId]/reviews/schedule.get';
import schedulePut from '../../../../src/server/api/v1/orgs/[orgId]/reviews/schedule.put';
import staleGet from '../../../../src/server/api/v1/orgs/[orgId]/reviews/stale.get';
import accountDisable from '../../../../src/server/api/v1/orgs/[orgId]/service-accounts/[saId]/disable.post';
import keyList from '../../../../src/server/api/v1/orgs/[orgId]/service-accounts/[saId]/keys/index.get';
import keyCreate from '../../../../src/server/api/v1/orgs/[orgId]/service-accounts/[saId]/keys/index.post';
import accountList from '../../../../src/server/api/v1/orgs/[orgId]/service-accounts/index.get';
import accountCreate from '../../../../src/server/api/v1/orgs/[orgId]/service-accounts/index.post';
import settingsGet from '../../../../src/server/api/v1/orgs/[orgId]/settings.get';
import settingsPut from '../../../../src/server/api/v1/orgs/[orgId]/settings.put';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import type { Facts } from '../../../../src/server/domain/authorize';
import {
	setGovernanceServices,
	type GovernanceServices
} from '../../../../src/server/services/governance';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import type { OrgRole } from '../../../../src/shared/permissions';
import { facts, fresh, member, NOW, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const BASE = `/api/v1/orgs/${ORG}`;
const R = '/api/v1/orgs/:orgId';
const TABLES =
	/TABLE IF NOT EXISTS (users|members|organizations|api_keys|api_key_lookup|invites|delegations|site_grants|sites|departments|department_members|service_accounts|service_account_keys|access_reviews|access_review_items|access_review_schedules|org_settings) \(/;

function world(
	role: OrgRole | null = 'owner',
	options: { stepUp?: boolean; departmentAdminOf?: string } = {}
) {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) if (TABLES.test(statement)) sql.exec(statement);
	const exec = (text: string, ...binds: unknown[]) =>
		sql.prepare(text).run(...(binds as never[]));
	const db = {
		async first(_key: string, text: string, binds: unknown[] = []) {
			return sql.prepare(text).get(...(binds as never[])) ?? null;
		},
		async all(_key: string, text: string, binds: unknown[] = []) {
			return { results: sql.prepare(text).all(...(binds as never[])) };
		},
		async run(_key: string, text: string, binds: unknown[] = []) {
			const result = sql.prepare(text).run(...(binds as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	for (const [id, mail] of [
		['user-1', 'one@example.test'],
		['user-2', 'two@example.test'],
		['user-3', 'three@example.test']
	]) {
		exec('INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)', id, mail);
	}
	const addMember = (org: string, user: string, memberRole: string) =>
		exec(
			'INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
			`m-${org}-${user}`,
			org,
			user,
			memberRole
		);
	if (role !== null) addMember(ORG, 'user-1', role);
	addMember(ORG, 'user-2', 'developer');
	addMember(OTHER_ORG, 'user-3', 'owner');

	let counter = 0;
	const trail: { orgId: string; action: string; target: string }[] = [];
	const asOwner = () => facts({ ...member('owner'), ...fresh });
	const services: GovernanceServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, action: input.action, target: input.target });
		},
		now: () => NOW,
		newId: () => `n${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`,
		ownerFacts: async () => asOwner(),
		reviewMail: async () => ({ sent: 0, skipped: 0 })
	};
	setGovernanceServices(services);
	const departmental: Partial<Facts> =
		options.departmentAdminOf === undefined
			? {}
			: {
					grants: [
						{
							level: 'department',
							orgId: ORG,
							targetId: options.departmentAdminOf,
							role: 'admin'
						}
					],
					departments: [
						{ id: 'd-top', parentId: null, kind: 'department' },
						{ id: 'd-child', parentId: 'd-top', kind: 'department' },
						{ id: 'd-other', parentId: null, kind: 'department' }
					]
				};
	const harness = setup({
		role: role ?? 'viewer',
		facts: () =>
			options.stepUp === false
				? facts({ ...member(role ?? 'viewer'), ...departmental })
				: facts({ ...member(role ?? 'viewer'), ...fresh, ...departmental })
	});
	return { sql, exec, trail, harness };
}

afterEach(() => {
	setGovernanceServices(null);
	resetApiDeps();
});

const call = (
	handler: Parameters<typeof send>[0],
	route: string,
	path: string,
	over: { method?: string; headers?: Record<string, string>; json?: unknown } = {}
) => send(handler, route, { path, headers: asUser, ...over });

const sa = (id: string, org: string, owner = 'user-1', department: string | null = null) =>
	`INSERT INTO service_accounts (id, organization_id, department_id, name, owner_user_id, expires_at, disabled_at, created_at)
	 VALUES ('${id}', '${org}', ${department === null ? 'NULL' : `'${department}'`}, 'Bot ${id}', '${owner}', ${NOW + 86_400_000}, NULL, 1)`;

describe('service account routes', () => {
	it('lists for an owner and refuses another organization and a viewer', async () => {
		const w = world();
		w.exec(sa('sa-1', ORG));
		const ok = await call(accountList, `${R}/service-accounts`, `${BASE}/service-accounts`);
		expect(ok.status).toBe(200);
		expect((ok.json as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['sa-1']);
		const other = await call(
			accountList,
			`${R}/service-accounts`,
			`/api/v1/orgs/${OTHER_ORG}/service-accounts`
		);
		expect(other.status).toBe(403);
		world('viewer');
		const denied = await call(accountList, `${R}/service-accounts`, `${BASE}/service-accounts`);
		expect(denied.status).toBe(403);
	});

	it('creates an account, audits it, and refuses an expiry past a year', async () => {
		const w = world();
		const create = (expiresInDays: number) =>
			call(accountCreate, `${R}/service-accounts`, `${BASE}/service-accounts`, {
				method: 'POST',
				json: { name: 'Deploy Bot', ownerUserId: 'user-2', expiresInDays },
				headers: { ...asUser, 'idempotency-key': `create-${expiresInDays}` }
			});
		const made = await create(90);
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ state: 'active', ownerUserId: 'user-2' });
		expect(w.trail.at(-1)).toMatchObject({ orgId: ORG, action: 'service-account.created' });
		expect((await create(366)).status).toBe(400);
	});

	it('will not disable or list the keys of an account in another organization', async () => {
		const w = world();
		w.exec(sa('sa-foreign', OTHER_ORG, 'user-3'));
		const disable = await call(
			accountDisable,
			`${R}/service-accounts/:saId/disable`,
			`${BASE}/service-accounts/sa-foreign/disable`,
			{ method: 'POST', json: {} }
		);
		expect(disable.status).toBe(404);
		const keys = await call(
			keyList,
			`${R}/service-accounts/:saId/keys`,
			`${BASE}/service-accounts/sa-foreign/keys`
		);
		expect(keys.status).toBe(404);
		const issue = await call(
			keyCreate,
			`${R}/service-accounts/:saId/keys`,
			`${BASE}/service-accounts/sa-foreign/keys`,
			{ method: 'POST', json: { name: 'k', scopes: ['key.read'], expiry: '30d' } }
		);
		expect(issue.status).toBe(404);
	});

	it('creates a key once with a fresh sign-in, never for an API key or without step-up', async () => {
		const w = world();
		w.exec(sa('sa-1', ORG, 'user-2'));
		const path = `${BASE}/service-accounts/sa-1/keys`;
		const route = `${R}/service-accounts/:saId/keys`;
		const json = { name: 'ci', scopes: ['key.read'], expiry: '30d' };
		const made = await call(keyCreate, route, path, { method: 'POST', json });
		expect(made.status).toBe(201);
		expect((made.json as { token: string }).token).toMatch(/^dfk_/);
		const listed = await call(keyList, route, path);
		expect((listed.json as { items: unknown[] }).items).toHaveLength(1);
		const byKey = await call(keyCreate, route, path, { method: 'POST', json, headers: asKey });
		expect(byKey.status).toBe(403);
		const replay = await call(keyCreate, route, path, {
			method: 'POST',
			json,
			headers: { ...asUser, 'idempotency-key': 'abcd-0001' }
		});
		expect(replay.status).toBe(400);
		world('owner', { stepUp: false });
		const stale = await call(keyCreate, route, path, { method: 'POST', json });
		expect(stale.status).toBe(403);
	});

	it('disables an account and says so in the list', async () => {
		const w = world();
		w.exec(sa('sa-1', ORG));
		const reply = await call(
			accountDisable,
			`${R}/service-accounts/:saId/disable`,
			`${BASE}/service-accounts/sa-1/disable`,
			{ method: 'POST', json: {} }
		);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ state: 'disabled' });
		expect(w.trail.at(-1)?.action).toBe('service-account.disabled');
	});
});

describe('review routes', () => {
	const open = (w: ReturnType<typeof world>) =>
		call(reviewCreate, `${R}/reviews`, `${BASE}/reviews`, {
			method: 'POST',
			json: { scope: 'organization' },
			headers: { ...asUser, 'idempotency-key': `review-${w.trail.length}-0001` }
		});

	it('opens, lists and reads a review, and flags the item about the viewer', async () => {
		const w = world();
		const made = await open(w);
		expect(made.status).toBe(201);
		const id = (made.json as { id: string }).id;
		expect(made.json).toMatchObject({ state: 'open', total: 2, pending: 2 });
		const list = await call(reviewList, `${R}/reviews`, `${BASE}/reviews`);
		expect((list.json as { items: unknown[] }).items).toHaveLength(1);
		const detail = await call(reviewGet, `${R}/reviews/:reviewId`, `${BASE}/reviews/${id}`);
		const items = (detail.json as { items: { own: boolean; heldBy: string }[] }).items;
		expect(items.find((item) => item.own)?.heldBy).toBe('one@example.test');
	});

	it('refuses a viewer on manage and an owner of another organization on read', async () => {
		world('viewer');
		expect((await open(world('viewer'))).status).toBe(403);
		world();
		const foreign = await call(reviewList, `${R}/reviews`, `/api/v1/orgs/${OTHER_ORG}/reviews`);
		expect(foreign.status).toBe(403);
	});

	it('answers 404 for a review that belongs to another organization', async () => {
		const w = world();
		w.exec(
			`INSERT INTO access_reviews (id, organization_id, scope, state, due_at, created_by, created_at)
			 VALUES ('rv-foreign', '${OTHER_ORG}', 'organization', 'open', 1, 'x', 1)`
		);
		for (const [handler, route, path, extra] of [
			[reviewGet, `${R}/reviews/:reviewId`, `${BASE}/reviews/rv-foreign`, {}],
			[
				reviewClose,
				`${R}/reviews/:reviewId/close`,
				`${BASE}/reviews/rv-foreign/close`,
				{ method: 'POST', json: {} }
			],
			[
				reviewDecide,
				`${R}/reviews/:reviewId/decisions`,
				`${BASE}/reviews/rv-foreign/decisions`,
				{ method: 'POST', json: { kind: 'member', subjectRef: 'x', decision: 'keep' } }
			],
			[
				reviewEvidence,
				`${R}/reviews/:reviewId/evidence`,
				`${BASE}/reviews/rv-foreign/evidence`,
				{}
			]
		] as const) {
			const reply = await call(handler, route, path, extra);
			expect(reply.status, path).toBe(404);
		}
	});

	it('refuses to decide an item about yourself', async () => {
		const w = world();
		const id = ((await open(w)).json as { id: string }).id;
		const reply = await call(
			reviewDecide,
			`${R}/reviews/:reviewId/decisions`,
			`${BASE}/reviews/${id}/decisions`,
			{
				method: 'POST',
				json: { kind: 'member', subjectRef: 'm-org-1-user-1', decision: 'keep' }
			}
		);
		expect(reply.status).toBe(403);
		const other = await call(
			reviewDecide,
			`${R}/reviews/:reviewId/decisions`,
			`${BASE}/reviews/${id}/decisions`,
			{
				method: 'POST',
				json: { kind: 'member', subjectRef: 'm-org-1-user-2', decision: 'keep' }
			}
		);
		expect(other.status).toBe(200);
	});

	it('exports the evidence of a closed review as JSON and CSV with the same hash', async () => {
		const w = world();
		w.exec(
			`INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES ('m-x', '${ORG}', 'user-3', 'viewer', 1, 1)`
		);
		const id = ((await open(w)).json as { id: string }).id;
		const too = await call(
			reviewEvidence,
			`${R}/reviews/:reviewId/evidence`,
			`${BASE}/reviews/${id}/evidence`
		);
		expect(too.status).toBe(409);
		w.exec(
			`UPDATE access_review_items SET decision = 'keep', decided_by = 'user:user-2', decided_at = 5
			 WHERE review_id = ?`,
			id
		);
		w.exec(`UPDATE access_reviews SET state = 'closed', closed_at = 9 WHERE id = ?`, id);
		const json = await call(
			reviewEvidence,
			`${R}/reviews/:reviewId/evidence`,
			`${BASE}/reviews/${id}/evidence`
		);
		expect(json.status).toBe(200);
		const csv = await call(
			reviewEvidence,
			`${R}/reviews/:reviewId/evidence`,
			`${BASE}/reviews/${id}/evidence?format=csv`
		);
		expect(csv.headers.get('content-type')).toContain('text/csv');
		expect(csv.headers.get('x-content-sha256')).toBe((json.json as { sha256: string }).sha256);
	});

	it('refuses to close with items waiting', async () => {
		const w = world();
		const id = ((await open(w)).json as { id: string }).id;
		const reply = await call(
			reviewClose,
			`${R}/reviews/:reviewId/close`,
			`${BASE}/reviews/${id}/close`,
			{ method: 'POST', json: {} }
		);
		expect(reply.status).toBe(409);
	});

	it('reads and sets the schedule, and reports the stale list', async () => {
		world();
		const none = await call(scheduleGet, `${R}/reviews/schedule`, `${BASE}/reviews/schedule`);
		expect(none.json).toEqual({ interval: 'off', lastOpenedAt: null });
		const set = await call(schedulePut, `${R}/reviews/schedule`, `${BASE}/reviews/schedule`, {
			method: 'PUT',
			json: { interval: 'yearly' }
		});
		expect(set.json).toMatchObject({ interval: 'yearly' });
		const bad = await call(schedulePut, `${R}/reviews/schedule`, `${BASE}/reviews/schedule`, {
			method: 'PUT',
			json: { interval: 'daily' }
		});
		expect(bad.status).toBe(400);
		const stale = await call(staleGet, `${R}/reviews/stale`, `${BASE}/reviews/stale`);
		expect(stale.json).toEqual({ days: 90, items: [] });
	});
});

describe('offboard route', () => {
	const path = `${BASE}/members/m-org-1-user-2/offboard`;
	const route = `${R}/members/:memberId/offboard`;

	it('lists the effects in a dry run without a fresh sign-in and changes nothing', async () => {
		const w = world('owner', { stepUp: false });
		const reply = await call(offboard, route, path, { method: 'POST', json: { dryRun: true } });
		expect(reply.status).toBe(200);
		expect((reply.json as { effects: { kind: string }[] }).effects[0]?.kind).toBe('membership');
		expect(
			w.sql.prepare(`SELECT COUNT(*) AS n FROM members WHERE user_id = 'user-2'`).get()
		).toEqual({ n: 1 });
	});

	it('needs a fresh sign-in to run for real', async () => {
		const w = world('owner', { stepUp: false });
		const reply = await call(offboard, route, path, { method: 'POST', json: {} });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(
			w.sql.prepare(`SELECT COUNT(*) AS n FROM members WHERE user_id = 'user-2'`).get()
		).toEqual({ n: 1 });
	});

	it('removes the person with a fresh sign-in and audits each effect', async () => {
		const w = world();
		const reply = await call(offboard, route, path, { method: 'POST', json: {} });
		expect(reply.status).toBe(200);
		expect(
			w.sql.prepare(`SELECT COUNT(*) AS n FROM members WHERE user_id = 'user-2'`).get()
		).toEqual({ n: 0 });
		expect(w.trail.map((row) => row.action)).toContain('offboard.membership');
	});

	it('answers 404 for a member of another organization and 403 for a developer', async () => {
		world();
		const foreign = await call(offboard, route, `${BASE}/members/m-org-2-user-3/offboard`, {
			method: 'POST',
			json: { dryRun: true }
		});
		expect(foreign.status).toBe(404);
		world('developer');
		const denied = await call(offboard, route, path, {
			method: 'POST',
			json: { dryRun: true }
		});
		expect(denied.status).toBe(403);
	});
});

describe('department admins on the review routes', () => {
	const seed = (w: ReturnType<typeof world>) => {
		w.exec(
			`INSERT INTO access_reviews (id, organization_id, scope, state, due_at, created_by, created_at)
			 VALUES ('rv-d', '${ORG}', 'organization', 'open', 1, 'x', 1)`
		);
		for (const [ref, user, department] of [
			['in-child', 'user-2', 'd-child'],
			['in-other', 'user-2', 'd-other'],
			['org-level', 'user-2', null],
			['about-me', 'user-1', 'd-top']
		] as const) {
			w.exec(
				`INSERT INTO access_review_items (organization_id, review_id, kind, subject_ref, subject_user_id, label, detail, decision, department_id)
				 VALUES (?, 'rv-d', 'grant', ?, ?, ?, 'd', 'pending', ?)`,
				ORG,
				ref,
				user,
				ref,
				department
			);
		}
	};
	const decide = (ref: string, json: object = {}) =>
		call(reviewDecide, `${R}/reviews/:reviewId/decisions`, `${BASE}/reviews/rv-d/decisions`, {
			method: 'POST',
			json: { kind: 'grant', subjectRef: ref, decision: 'keep', ...json }
		});

	it('lists and reads only the items in the subtree, filtered on the server', async () => {
		const w = world('viewer', { departmentAdminOf: 'd-top' });
		seed(w);
		const list = await call(reviewList, `${R}/reviews`, `${BASE}/reviews`);
		expect(list.status).toBe(200);
		expect((list.json as { items: { total: number }[] }).items[0]?.total).toBe(2);
		const detail = await call(reviewGet, `${R}/reviews/:reviewId`, `${BASE}/reviews/rv-d`);
		expect(detail.status).toBe(200);
		const body = detail.json as { limited: boolean; items: { subjectRef: string }[] };
		expect(body.limited).toBe(true);
		expect(body.items.map((item) => item.subjectRef).sort()).toEqual(['about-me', 'in-child']);
	});

	it('decides an item in the subtree and answers 404 for any other', async () => {
		const w = world('viewer', { departmentAdminOf: 'd-top' });
		seed(w);
		expect((await decide('in-child')).status).toBe(200);
		expect((await decide('in-other')).status).toBe(404);
		expect((await decide('org-level')).status).toBe(404);
		expect((await decide('about-me')).status).toBe(403);
		expect(w.trail.filter((row) => row.action === 'access-review.decided')).toHaveLength(1);
	});

	it('leaves applying now and closing to owners and admins', async () => {
		const w = world('viewer', { departmentAdminOf: 'd-top' });
		seed(w);
		const now = await decide('in-child', { decision: 'revoke', applyNow: true });
		expect(now.status).toBe(403);
		const closed = await call(
			reviewClose,
			`${R}/reviews/:reviewId/close`,
			`${BASE}/reviews/rv-d/close`,
			{ method: 'POST', json: {} }
		);
		expect(closed.status).toBe(403);
		const evidence = await call(
			reviewEvidence,
			`${R}/reviews/:reviewId/evidence`,
			`${BASE}/reviews/rv-d/evidence`
		);
		expect(evidence.status).toBe(403);
	});

	it('refuses new decisions once the setting is off', async () => {
		const w = world('viewer', { departmentAdminOf: 'd-top' });
		seed(w);
		w.exec(
			`INSERT INTO org_settings (organization_id, setting, value, set_by, set_at)
			 VALUES (?, 'review.department-admins-decide', '0', 'x', 1)`,
			ORG
		);
		const reply = await decide('in-child');
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { reason: 'department_decisions_off' } });
		const detail = await call(reviewGet, `${R}/reviews/:reviewId`, `${BASE}/reviews/rv-d`);
		expect(detail.status).toBe(404);
	});

	it('gives a plain viewer and a department admin of another branch nothing', async () => {
		const plain = world('viewer');
		seed(plain);
		expect((await call(reviewList, `${R}/reviews`, `${BASE}/reviews`)).status).toBe(403);
		expect((await decide('in-child')).status).toBe(404);
		const other = world('viewer', { departmentAdminOf: 'd-other' });
		seed(other);
		expect((await decide('in-child')).status).toBe(404);
	});
});

describe('settings routes', () => {
	const get = () => call(settingsGet, `${R}/settings`, `${BASE}/settings`);
	const put = (json: unknown) =>
		call(settingsPut, `${R}/settings`, `${BASE}/settings`, { method: 'PUT', json });

	it('reads the default to every member', async () => {
		world('developer');
		const reply = await get();
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ departmentAdminsDecideReviews: true });
	});

	it('lets an owner and an admin change it, with an audit row, and refuses everyone else', async () => {
		for (const role of ['owner', 'admin'] as const) {
			const w = world(role, { stepUp: false });
			const reply = await put({ departmentAdminsDecideReviews: false });
			expect(reply.status, role).toBe(200);
			expect(reply.json).toEqual({ departmentAdminsDecideReviews: false });
			expect(w.trail.at(-1)).toMatchObject({ action: 'org.settings.updated', orgId: ORG });
			expect((await get()).json).toEqual({ departmentAdminsDecideReviews: false });
		}
		for (const role of ['developer', 'viewer', 'billing'] as const) {
			world(role);
			expect((await put({ departmentAdminsDecideReviews: false })).status, role).toBe(403);
		}
		const department = world('viewer', { departmentAdminOf: 'd-top' });
		expect((await put({ departmentAdminsDecideReviews: false })).status).toBe(403);
		expect(department.trail).toHaveLength(0);
	});

	it('refuses a body with anything else in it, and another organization', async () => {
		world();
		expect((await put({ departmentAdminsDecideReviews: 'yes' })).status).toBe(400);
		expect((await put({ departmentAdminsDecideReviews: true, extra: 1 })).status).toBe(400);
		const foreign = await call(
			settingsGet,
			`${R}/settings`,
			`/api/v1/orgs/${OTHER_ORG}/settings`
		);
		expect(foreign.status).toBe(403);
	});
});
