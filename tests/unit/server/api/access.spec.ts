import type { SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import getAccess from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/access/index.get';
import removeRule from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/access/rules/[ruleId].delete';
import addRule from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/access/rules/index.post';
import syncRules from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/access/sync.post';
import { createEnvironment } from '../../../../src/server/db/repos/environments';
import { derive, type Entitlement } from '../../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../../src/server/integrations/engine';
import {
	resetAccessServices,
	setAccessServices
} from '../../../../src/server/services/access-rules';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG } from '../../domain/fixtures';
import { SITES, asKey, asUser, send, setup } from '../fixtures/harness';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const SITE = `site_${'f'.repeat(20)}`;
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE}/access`;
const LIST = '/api/v1/orgs/:orgId/sites/:id/access';
const RULES = '/api/v1/orgs/:orgId/sites/:id/access/rules';
const ONE = '/api/v1/orgs/:orgId/sites/:id/access/rules/:ruleId';
const SYNC = '/api/v1/orgs/:orgId/sites/:id/access/sync';

let fixture: ReturnType<typeof sqliteClient>;
let started: EngineStartRequest[];
let plan: string;
let startFails: boolean;
let clock: number;

const entitlementOf = (planId: string): Entitlement => {
	const result = derive(planId);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

beforeEach(async () => {
	fixture = sqliteClient();
	SITES[SITE] = ORG;
	addReadySite(fixture.raw, ORG, SITE);
	fixture.raw.prepare('UPDATE sites SET account_id = ? WHERE id = ?').run('a'.repeat(32), SITE);
	await createEnvironment(fixture.client, {
		id: 'env_stage',
		organizationId: ORG,
		siteId: SITE,
		kind: 'staging',
		name: 'staging',
		host: 'staging.drupflare.app',
		status: 'ready',
		envSiteId: null,
		sourceBackupId: null,
		ttlAt: null,
		createdAt: 1
	});
	started = [];
	plan = 'managed-agency';
	startFails = false;
	clock = 5_000;
	const withBatch = {
		...fixture.client,
		batch: async (statements: { sql: string; bindings: SQLInputValue[] }[]) => {
			for (const statement of statements) {
				fixture.raw.prepare(statement.sql).run(...statement.bindings);
			}
			return [{ shard: 'main' }];
		}
	} as unknown as typeof fixture.client;
	setAccessServices({
		getDb: async () => withBatch,
		planOf: async () => entitlementOf(plan),
		startOperation: async (request) => {
			if (startFails) throw new Error('down');
			started.push(request);
		},
		audit: async () => undefined,
		now: () => clock
	});
});

afterEach(() => {
	delete SITES[SITE];
	resetAccessServices();
	resetApiDeps();
});

const add = (json: unknown, headers: Record<string, string> = asUser) =>
	send(addRule, RULES, { method: 'POST', path: `${BASE}/rules`, headers, json });

describe('GET access', () => {
	it('lists no rules, the presets the plan includes and the invitee limit', async () => {
		setup({ role: 'admin' });
		plan = 'managed-free';
		const reply = await send(getAccess, LIST, { path: BASE, headers: asUser });
		expect(reply.status).toBe(200);
		const body = reply.json as any;
		expect(body.rules).toEqual([]);
		expect(body.inviteeLimit).toBe(5);
		const review = body.presets.find((p: any) => p.id === 'review-link');
		expect(review.available).toBe(true);
		expect(body.presets.find((p: any) => p.id === 'members').available).toBe(true);
		const sso = body.presets.find((p: any) => p.id === 'sso');
		expect(sso.available).toBe(false);
		expect(sso.unlockedBy).toBe('Institution Standard');
	});

	it('answers not found for a site the caller cannot see', async () => {
		setup({ role: 'admin' });
		const reply = await send(getAccess, LIST, {
			path: `/api/v1/orgs/${ORG}/sites/site_${'9'.repeat(20)}/access`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('POST access rules', () => {
	it('adds a rule and starts the change that applies it to the site', async () => {
		setup({ role: 'admin' });
		const reply = await add({ environment: 'env_stage', preset: 'members' });
		expect(reply.status).toBe(201);
		expect((reply.json as any).rule).toMatchObject({
			environment: 'env_stage',
			preset: 'members'
		});
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			workflow: 'access-sync',
			id: (reply.json as any).operationId
		});
		expect(started[0]!.params).toMatchObject({ orgId: ORG, siteId: SITE });
		const listed = await send(getAccess, LIST, { path: BASE, headers: asUser });
		expect((listed.json as any).rules).toHaveLength(1);
	});

	it('starts one change for each rule added or removed and returns its operation id', async () => {
		setup({ role: 'admin' });
		await add({ environment: 'env_stage', preset: 'members' });
		const second = await add({ environment: 'env_stage', preset: 'grants' });
		const id = (second.json as any).rule.id as string;
		const gone = await send(removeRule, ONE, {
			method: 'DELETE',
			path: `${BASE}/rules/${id}`,
			headers: asUser
		});
		expect(gone.status).toBe(200);
		expect(started).toHaveLength(3);
		expect(new Set(started.map((request) => request.id)).size).toBe(3);
		expect((second.json as any).operationId).toBe(started[1]!.id);
		expect((gone.json as any).operationId).toBe(started[2]!.id);
		expect(
			fixture.raw
				.prepare("SELECT COUNT(*) AS n FROM operations WHERE type = 'access.sync'")
				.get()
		).toEqual({ n: 3 });
	});

	it('stores a password as a salted hash and never echoes it', async () => {
		setup({ role: 'admin' });
		const reply = await add({
			environment: 'prod',
			preset: 'password',
			password: 'correct horse battery'
		});
		expect(reply.status).toBe(201);
		expect(reply.text).not.toContain('correct horse');
		const stored = fixture.raw.prepare('SELECT config FROM site_access_rules').get() as {
			config: string;
		};
		expect(stored.config).not.toContain('correct horse');
		expect(JSON.parse(stored.config)).toHaveProperty('passwordHash');
	});

	it('returns a review link token once and stores only its hash', async () => {
		setup({ role: 'admin' });
		const reply = await add({ environment: 'env_stage', preset: 'review-link' });
		const token = (reply.json as any).linkToken as string;
		expect(token.length).toBeGreaterThan(20);
		const stored = fixture.raw.prepare('SELECT config FROM site_access_rules').get() as {
			config: string;
		};
		expect(stored.config).not.toContain(token);
		const listed = await send(getAccess, LIST, { path: BASE, headers: asUser });
		expect(listed.text).not.toContain(token);
		expect((listed.json as any).rules[0].expiresAt).toBe(5_000 + 168 * 3_600_000);
	});

	it('allows a review link on the free plan', async () => {
		setup({ role: 'admin' });
		plan = 'managed-free';
		const reply = await add({ environment: 'env_stage', preset: 'review-link' });
		expect(reply.status).toBe(201);
		expect(started).toHaveLength(1);
	});

	it('refuses single sign-on below Institution Standard and names that plan', async () => {
		setup({ role: 'admin' });
		plan = 'managed-pro';
		const reply = await add({ environment: 'prod', preset: 'sso' });
		expect(reply.status).toBe(403);
		expect((reply.json as any).details).toEqual({ unlockedBy: 'institution-standard' });
		expect((reply.json as any).message).toContain('Institution Standard');
		expect(started).toEqual([]);
	});

	it('refuses invited addresses past the plan limit', async () => {
		setup({ role: 'admin' });
		plan = 'managed-free';
		const emails = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}@x.org`);
		const reply = await add({ environment: 'prod', preset: 'email-invite', values: emails });
		expect(reply.status).toBe(409);
	});

	it('refuses a value-based preset with no values, a password rule with no password and an unknown environment', async () => {
		setup({ role: 'admin' });
		expect((await add({ environment: 'prod', preset: 'github-org' })).status).toBe(400);
		expect((await add({ environment: 'prod', preset: 'password' })).status).toBe(400);
		expect((await add({ environment: 'env_nope', preset: 'members' })).status).toBe(400);
	});

	it('needs a session, so an API key is refused', async () => {
		setup({ role: 'admin' });
		const reply = await add({ environment: 'prod', preset: 'members' }, asKey);
		expect(reply.status).toBe(403);
		expect(started).toEqual([]);
	});

	it('keeps the rule and says so when the site has not picked up the change', async () => {
		setup({ role: 'admin' });
		startFails = true;
		const reply = await add({ environment: 'env_stage', preset: 'members' });
		expect(reply.status).toBe(409);
		expect((reply.json as any).message).toContain('saved');
		expect((reply.json as any).details).toEqual({ saved: true });
		const rows = fixture.raw.prepare('SELECT id FROM site_access_rules').all();
		expect(rows).toHaveLength(1);
		const listed = await send(getAccess, LIST, { path: BASE, headers: asUser });
		expect((listed.json as any).activeOnSite).toBe(false);
	});

	it('keeps the rule and says so when the site is not active yet', async () => {
		setup({ role: 'admin' });
		fixture.raw.prepare("UPDATE sites SET state = 'suspended' WHERE id = ?").run(SITE);
		const reply = await add({ environment: 'env_stage', preset: 'members' });
		expect(reply.status).toBe(409);
		expect(started).toEqual([]);
		expect(fixture.raw.prepare('SELECT id FROM site_access_rules').all()).toHaveLength(1);
	});

	it('is refused for a viewer', async () => {
		setup({ role: 'viewer' });
		const reply = await add({ environment: 'prod', preset: 'members' });
		expect(reply.status).toBe(403);
	});
});

describe('DELETE access rules', () => {
	it('answers not found for an unknown or already removed rule', async () => {
		setup({ role: 'admin' });
		const reply = await send(removeRule, ONE, {
			method: 'DELETE',
			path: `${BASE}/rules/rule_missing`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('activeOnSite', () => {
	const read = async () =>
		(await send(getAccess, LIST, { path: BASE, headers: asUser })).json as {
			activeOnSite: boolean;
		};

	it('is true for a site that never had a rule', async () => {
		setup({ role: 'admin' });
		expect((await read()).activeOnSite).toBe(true);
	});

	it('is false while the change runs and true once it succeeded', async () => {
		setup({ role: 'admin' });
		const reply = await add({ environment: 'env_stage', preset: 'members' });
		expect((await read()).activeOnSite).toBe(false);
		fixture.raw
			.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?")
			.run((reply.json as any).operationId);
		expect((await read()).activeOnSite).toBe(true);
	});

	it('is false again after a later change fails or has not finished', async () => {
		setup({ role: 'admin' });
		const first = await add({ environment: 'env_stage', preset: 'members' });
		fixture.raw
			.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?")
			.run((first.json as any).operationId);
		clock = Date.now() + 60_000;
		const second = await add({ environment: 'env_stage', preset: 'grants' });
		fixture.raw
			.prepare("UPDATE operations SET status = 'failed' WHERE id = ?")
			.run((second.json as any).operationId);
		expect((await read()).activeOnSite).toBe(false);
	});

	it('is false after the last rule is removed until that removal reaches the site', async () => {
		setup({ role: 'admin' });
		const first = await add({ environment: 'env_stage', preset: 'members' });
		fixture.raw
			.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?")
			.run((first.json as any).operationId);
		const id = (first.json as any).rule.id as string;
		clock = Date.now() + 60_000;
		const gone = await send(removeRule, ONE, {
			method: 'DELETE',
			path: `${BASE}/rules/${id}`,
			headers: asUser
		});
		expect((await read()).activeOnSite).toBe(false);
		fixture.raw
			.prepare("UPDATE operations SET status = 'succeeded', created_at = ? WHERE id = ?")
			.run(clock + 1, (gone.json as any).operationId);
		expect((await read()).activeOnSite).toBe(true);
	});
});

describe('POST access sync', () => {
	it('starts the change again and returns its operation id', async () => {
		setup({ role: 'admin' });
		await add({ environment: 'env_stage', preset: 'members' });
		const reply = await send(syncRules, SYNC, {
			method: 'POST',
			path: `${BASE}/sync`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(started).toHaveLength(2);
		expect((reply.json as any).operationId).toBe(started[1]!.id);
	});

	it('is refused for a viewer', async () => {
		setup({ role: 'viewer' });
		const reply = await send(syncRules, SYNC, {
			method: 'POST',
			path: `${BASE}/sync`,
			headers: asUser
		});
		expect(reply.status).toBe(403);
		expect(started).toEqual([]);
	});
});
