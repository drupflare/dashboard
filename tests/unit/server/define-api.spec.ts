import { defineEventHandler } from 'h3';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorEnvelope } from '../../../contracts/src/common';
import { acceptDelegation, createDelegation } from '../../../src/server/domain/delegation';
import {
	defineApi,
	isApiHandler,
	productionDeps,
	resetApiDeps,
	setApiDeps,
	type AnyApiMeta
} from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { ACTIONS, actionDef } from '../../../src/shared/permissions';
import { AGENCY, NOW, ORG, SITE, admin, facts, fresh, member } from '../domain/fixtures';
import aggregatesGet from './fixtures/api/v1/admin/aggregates.get';
import codePost from './fixtures/api/v1/auth/code.post';
import meGet from './fixtures/api/v1/me.get';
import keysPost from './fixtures/api/v1/orgs/[orgId]/keys.post';
import membersGet, { MEMBER_ROWS } from './fixtures/api/v1/orgs/[orgId]/members.get';
import siteDelete from './fixtures/api/v1/sites/[id].delete';
import siteGet from './fixtures/api/v1/sites/[id].get';
import deployPost, { deploys } from './fixtures/api/v1/sites/[id]/deploys.post';
import { SITES, asKey, asOtherUser, asUser, send, setup, type Reply } from './fixtures/harness';
import { thrownBy } from './utils/support';

afterEach(() => {
	resetApiDeps();
	deploys.length = 0;
});

const SITE_ROUTE = '/api/v1/sites/:id';
const DEPLOY_ROUTE = '/api/v1/sites/:id/deploys';
const KEY_ROUTE = '/api/v1/orgs/:orgId/keys';
const MEMBER_ROUTE = '/api/v1/orgs/:orgId/members';

const base = {
	scope: 'session',
	action: 'account.read',
	rateClass: 'read',
	tags: ['me'],
	summary: 'A route'
} as const;

function expectEnvelope(reply: Reply, code: string) {
	expect(errorEnvelope.safeParse(reply.json).success, reply.text).toBe(true);
	expect(reply.json).toMatchObject({ code });
	expect(reply.json).toHaveProperty('requestId', reply.headers.get('x-request-id'));
}

describe('defineApi: definition', () => {
	it('throws when a route has no action', () => {
		const meta = { ...base, action: undefined } as unknown as AnyApiMeta;
		expect(() => defineApi(meta, () => ({}))).toThrow('action is required');
		const empty = { ...base, action: '' } as unknown as AnyApiMeta;
		expect(() => defineApi(empty, () => ({}))).toThrow('action is required');
	});

	it('throws for an action that is not in the permission table', () => {
		const meta = { ...base, action: 'site.explode' } as unknown as AnyApiMeta;
		expect(() => defineApi(meta, () => ({}))).toThrow('not in the permission table');
		const inherited = { ...base, action: 'toString' } as unknown as AnyApiMeta;
		expect(() => defineApi(inherited, () => ({}))).toThrow('not in the permission table');
	});

	it('accepts every action in the table on a route of the matching scope', () => {
		const scopes = {
			account: 'session',
			org: 'organization',
			department: 'organization',
			site: 'site',
			admin: 'admin'
		} as const;
		for (const action of ACTIONS) {
			const scope = scopes[actionDef(action).scope];
			const meta = { ...base, action, scope } as unknown as AnyApiMeta;
			expect(() => defineApi(meta, () => ({})), action).not.toThrow();
		}
	});

	it('requires a public action on a public route and a table action on every other route', () => {
		const publicWithTable = { ...base, scope: 'public', action: 'site.read' };
		expect(() => defineApi(publicWithTable as unknown as AnyApiMeta, () => ({}))).toThrow(
			'needs a public action'
		);
		const sessionWithPublic = { ...base, action: 'auth.code.request' };
		expect(() => defineApi(sessionWithPublic as unknown as AnyApiMeta, () => ({}))).toThrow(
			'not in the permission table'
		);
	});

	it('refuses an action whose scope does not fit the route scope', () => {
		const meta = { ...base, scope: 'site', action: 'org.read' } as unknown as AnyApiMeta;
		expect(() => defineApi(meta, () => ({}))).toThrow('cannot sit on a site route');
		const admin = { ...base, scope: 'session', action: 'admin.aggregates.read' };
		expect(() => defineApi(admin as unknown as AnyApiMeta, () => ({}))).toThrow(
			'cannot sit on a session route'
		);
	});

	it('refuses an unknown scope, rate class, tag, status and an empty summary', () => {
		const bad = (over: object) =>
			thrownBy(() => defineApi({ ...base, ...over } as unknown as AnyApiMeta, () => ({})));
		expect(String(bad({ scope: 'galaxy' }))).toContain('unknown scope');
		expect(String(bad({ rateClass: 'fast' }))).toContain('unknown rate class');
		expect(String(bad({ tags: ['nope'] }))).toContain('unknown tag');
		expect(String(bad({ tags: [] }))).toContain('tags is required');
		expect(String(bad({ summary: ' ' }))).toContain('summary is required');
		expect(String(bad({ successStatus: 302 }))).toContain('unsupported successStatus');
		expect(String(bad({ successStatus: 204, response: z.object({}) }))).toContain('204');
		expect(() => defineApi(null as never, () => ({}))).toThrow('meta is required');
	});

	it('carries meta and a brand that a plain event handler lacks', () => {
		const route = defineApi({ ...base }, () => ({}));
		expect(isApiHandler(route)).toBe(true);
		expect(route.meta).toMatchObject({ action: 'account.read', scope: 'session' });
		expect(isApiHandler(defineEventHandler(() => ({})))).toBe(false);
		expect(isApiHandler({ meta: route.meta })).toBe(false);
	});
});

describe('defineApi: authentication', () => {
	it('answers 401 with no credential, an unknown cookie and an unknown key', async () => {
		setup();
		const credentials: Record<string, string>[] = [
			{},
			{ cookie: 'session=nobody' },
			{ authorization: 'Bearer dfk_nope' }
		];
		for (const headers of credentials) {
			const reply = await send(siteGet, SITE_ROUTE, {
				path: `/api/v1/sites/${SITE}`,
				headers
			});
			expect(reply.status).toBe(401);
			expectEnvelope(reply, 'unauthenticated');
		}
	});

	it('answers 401 for an Authorization header that is not a dfk_ bearer and never falls back to the cookie', async () => {
		const { loads } = setup();
		for (const authorization of ['Basic abc', 'Bearer abc', 'Bearer', 'dfk_key1']) {
			const reply = await send(siteGet, SITE_ROUTE, {
				path: `/api/v1/sites/${SITE}`,
				headers: { ...asUser, authorization }
			});
			expect(reply.status, authorization).toBe(401);
		}
		expect(loads).toEqual([]);
	});

	it('refuses a resolver that returns a user for a bearer token or a key for a cookie', async () => {
		setup({
			deps: {
				resolvePrincipal: async (credential) =>
					credential.kind === 'bearer'
						? { kind: 'user', userId: 'user-1' }
						: { kind: 'key', keyId: 'key-1', issuerId: 'user-1' }
			}
		});
		for (const headers of [asKey, asUser]) {
			const reply = await send(siteGet, SITE_ROUTE, {
				path: `/api/v1/sites/${SITE}`,
				headers
			});
			expect(reply.status).toBe(401);
		}
	});

	it('serves a public route with no credential and never resolves a principal', async () => {
		let resolved = 0;
		const { loads } = setup({
			deps: {
				resolvePrincipal: async () => {
					resolved += 1;
					return null;
				}
			}
		});
		const reply = await send(codePost, '/api/v1/auth/code', {
			method: 'POST',
			path: '/api/v1/auth/code',
			json: { email: 'a@example.test' }
		});
		expect(reply.status).toBe(202);
		expect(reply.json).toEqual({ sent: true });
		expect(resolved).toBe(0);
		expect(loads).toEqual([]);
	});

	it('serves the signed-in account on a session route', async () => {
		setup();
		const reply = await send(meGet, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ kind: 'user' });
	});
});

describe('defineApi: authorization', () => {
	it('allows the owner and runs the handler with validated input', async () => {
		setup();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}?expand=config`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ id: SITE, name: 'fixture', expanded: true });
		expect(reply.headers.get('content-type')).toContain('application/json');
	});

	it('answers 403 with the same body for a non-member and for a member who lacks the role', async () => {
		const bodies: unknown[] = [];
		for (const role of [null, 'viewer'] as const) {
			setup({ role });
			const reply = await send(deployPost, DEPLOY_ROUTE, {
				method: 'POST',
				path: `/api/v1/sites/${SITE}/deploys`,
				headers: asUser,
				json: { ref: 'main' }
			});
			expect(reply.status).toBe(403);
			expectEnvelope(reply, 'forbidden');
			const { requestId: _id, ...rest } = reply.json as Record<string, unknown>;
			bodies.push(rest);
		}
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[0]).toEqual({
			code: 'forbidden',
			message: 'You do not have access to this resource',
			details: {}
		});
		expect(deploys).toEqual([]);
	});

	it('does not reveal why a suspended organisation or a policy denied the request', async () => {
		setup({
			facts: () => facts({ ...member('owner'), ...fresh, flags: { suspendedOrgIds: [ORG] } })
		});
		const reply = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: { ref: 'main' }
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			details: {},
			message: 'You do not have access to this resource'
		});
	});

	it('tells a proven member what to do next for step-up, plan features and budgets', async () => {
		setup({ facts: () => facts({ ...member('owner') }) });
		const stale = await send(siteDelete, SITE_ROUTE, {
			method: 'DELETE',
			path: `/api/v1/sites/${SITE}`,
			headers: asUser
		});
		expect(stale.status).toBe(403);
		expect(stale.json).toMatchObject({ details: { requires: 'step-up' } });

		setup({
			facts: () =>
				facts({ ...member('owner'), ...fresh, budgetExceeded: ['destructive-sites'] })
		});
		const budget = await send(siteDelete, SITE_ROUTE, {
			method: 'DELETE',
			path: `/api/v1/sites/${SITE}`,
			headers: asUser
		});
		expect(budget.json).toMatchObject({
			details: { requires: 'budget', budget: 'destructive-sites' }
		});

		const feature = defineApi(
			{ ...base, scope: 'organization', action: 'pilot.read', tags: ['pilots'] },
			() => ({})
		);
		setup({ facts: () => facts({ ...member('owner'), entitlements: [] }) });
		const missing = await send(feature, '/api/v1/orgs/:orgId/pilots', {
			path: '/api/v1/orgs/org-1/pilots',
			headers: asUser
		});
		expect(missing.json).toMatchObject({
			details: { requires: 'entitlement', feature: 'pilots' }
		});
	});

	it('answers 404 when the loader finds no resource and never calls authorize on nothing', async () => {
		setup();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: '/api/v1/sites/site-9',
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expectEnvelope(reply, 'not_found');
	});

	it('takes the organisation from the loader and never from request input', async () => {
		const { loads } = setup();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/site-2?orgId=${ORG}`,
			headers: { ...asUser, 'x-org-id': ORG }
		});
		expect(reply.status).toBe(403);
		expect(SITES['site-2']).not.toBe(ORG);
		expect(loads).toHaveLength(1);
		expect(loads[0]).toMatchObject({
			scope: 'site',
			action: 'site.read',
			params: { id: 'site-2' }
		});
	});

	it('refuses a key on a session-only action before it loads anything', async () => {
		const { loads, audits } = setup();
		const reply = await send(keysPost, KEY_ROUTE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/keys`,
			headers: asKey,
			json: { name: 'ci' }
		});
		expect(reply.status).toBe(403);
		expectEnvelope(reply, 'forbidden');
		expect(reply.json).toMatchObject({ details: {} });
		expect(loads).toEqual([]);
		expect(audits).toEqual([]);

		const adminReply = await send(aggregatesGet, '/api/v1/admin/aggregates', {
			path: '/api/v1/admin/aggregates',
			headers: asKey
		});
		expect(adminReply.status).toBe(403);
		expect(loads).toEqual([]);
	});

	it('lets the same user create a key on a session, and a key read what its scopes allow', async () => {
		setup();
		const created = await send(keysPost, KEY_ROUTE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/keys`,
			headers: asUser,
			json: { name: 'ci' }
		});
		expect(created.status).toBe(201);
		expect(created.json).toEqual({ id: 'key_ci' });

		const read = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: asKey
		});
		expect(read.status).toBe(200);
		const deploy = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asKey,
			json: { ref: 'main' }
		});
		expect(deploy.status).toBe(403);
		expect(deploys).toEqual([]);
	});

	it('answers a platform admin route only for a platform admin session', async () => {
		setup({ facts: () => facts({ ...member('owner'), ...fresh }) });
		const denied = await send(aggregatesGet, '/api/v1/admin/aggregates', {
			path: '/api/v1/admin/aggregates',
			headers: asUser
		});
		expect(denied.status).toBe(403);

		setup({ facts: () => facts({ ...admin }) });
		const allowed = await send(aggregatesGet, '/api/v1/admin/aggregates', {
			path: '/api/v1/admin/aggregates',
			headers: asUser
		});
		expect(allowed.status).toBe(200);
	});
});

describe('defineApi: validation', () => {
	it('lists each failing field path for a body, a query and a path parameter', async () => {
		setup();
		const body = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: { ref: '' }
		});
		expect(body.status).toBe(400);
		expectEnvelope(body, 'validation');
		expect(body.json).toMatchObject({ details: { issues: [{ path: 'ref' }] } });

		const query = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}?expand=everything`,
			headers: asUser
		});
		expect(query.json).toMatchObject({ details: { issues: [{ path: 'expand' }] } });

		const strict = defineApi(
			{
				...base,
				scope: 'site',
				action: 'site.read',
				tags: ['sites'],
				params: z.object({ id: z.string().regex(/^site-\d+$/) })
			},
			() => ({})
		);
		const param = await send(strict, SITE_ROUTE, {
			path: '/api/v1/sites/bogus',
			headers: asUser
		});
		expect(param.status).toBe(400);
		expect(param.json).toMatchObject({ details: { issues: [{ path: 'id' }] } });
	});

	it('rejects a body that is not JSON, not declared as JSON or over the size cap', async () => {
		setup();
		const path = `/api/v1/sites/${SITE}/deploys`;
		const call = (init: object) =>
			send(deployPost, DEPLOY_ROUTE, { method: 'POST', path, headers: asUser, ...init });
		const notJson = await call({
			raw: '{nope',
			headers: { ...asUser, 'content-type': 'application/json' }
		});
		expect(notJson.status).toBe(400);
		expect(notJson.json).toMatchObject({ message: 'Request body is not valid JSON' });

		const wrongType = await call({
			raw: '{"ref":"main"}',
			headers: { ...asUser, 'content-type': 'text/plain' }
		});
		expect(wrongType.status).toBe(400);
		expect(wrongType.json).toMatchObject({ message: 'Content-Type must be application/json' });
		expect(deploys).toEqual([]);

		const large = await call({ json: { ref: 'x'.repeat(2000) } });
		expect(large.status).toBe(400);
		expect(large.json).toMatchObject({ message: 'Request body is too large' });
	});

	it('validates before authorizing, so a bad body from a forbidden caller is a 400', async () => {
		setup({ role: 'viewer' });
		const reply = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(400);
	});
});

describe('defineApi: rate limiting', () => {
	const denied = {
		allowed: false,
		limit: 5,
		remaining: 0,
		resetSeconds: 30,
		retryAfterSeconds: 30,
		timestamps: []
	};

	it('answers 429 with the RateLimit headers and Retry-After and skips the handler', async () => {
		setup({ allow: () => denied });
		const reply = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: { ref: 'main' }
		});
		expect(reply.status).toBe(429);
		expectEnvelope(reply, 'rate_limited');
		expect(reply.json).toMatchObject({ details: { retryAfterSeconds: 30 } });
		expect(reply.headers.get('ratelimit-limit')).toBe('5');
		expect(reply.headers.get('ratelimit-remaining')).toBe('0');
		expect(reply.headers.get('ratelimit-reset')).toBe('30');
		expect(reply.headers.get('retry-after')).toBe('30');
		expect(deploys).toEqual([]);
	});

	it('puts the RateLimit headers on a success and no Retry-After', async () => {
		setup();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.headers.get('ratelimit-limit')).toBe('1000');
		expect(reply.headers.get('ratelimit-remaining')).toBe('999');
		expect(reply.headers.get('retry-after')).toBeNull();
	});

	it('counts a request that fails validation or authorization, keyed by the caller', async () => {
		const { limits } = setup({ role: 'viewer' });
		await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: {}
		});
		await send(siteGet, SITE_ROUTE, { path: `/api/v1/sites/${SITE}`, headers: asKey });
		await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: { 'cf-connecting-ip': '203.0.113.9' }
		});
		await send(siteGet, SITE_ROUTE, { path: `/api/v1/sites/${SITE}` });
		expect(limits).toEqual([
			{ routeClass: 'heavy', key: 'user:user-1' },
			{ routeClass: 'read', key: 'key:key-1' },
			{ routeClass: 'read', key: 'ip:203.0.113.9' },
			{ routeClass: 'read', key: 'ip:unknown' }
		]);
	});

	it('keys a public route by address and uses the auth-code class', async () => {
		const { limits } = setup();
		await send(codePost, '/api/v1/auth/code', {
			method: 'POST',
			path: '/api/v1/auth/code',
			headers: { 'cf-connecting-ip': '198.51.100.4' },
			json: { email: 'a@example.test' }
		});
		expect(limits).toEqual([{ routeClass: 'auth-code', key: 'ip:198.51.100.4' }]);
	});

	it('stops the sixth auth-code request from one address with the in-memory default limiter', async () => {
		setApiDeps({ resolvePrincipal: async () => null });
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const reply = await send(codePost, '/api/v1/auth/code', {
				method: 'POST',
				path: '/api/v1/auth/code',
				headers: { 'cf-connecting-ip': '192.0.2.77' },
				json: { email: 'a@example.test' }
			});
			statuses.push(reply.status);
		}
		expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
	});
});

describe('defineApi: idempotency', () => {
	const deploy = (headers: Record<string, string>, ref = 'main', path = SITE) =>
		send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${path}/deploys`,
			headers,
			json: { ref }
		});

	it('replays the stored result for a repeat and runs the handler once', async () => {
		setup();
		const headers = { ...asUser, 'idempotency-key': 'key-12345678' };
		const first = await deploy(headers);
		const second = await deploy(headers);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(first.headers.get('idempotency-replayed')).toBeNull();
		expect(second.headers.get('idempotency-replayed')).toBe('true');
		expect(deploys).toEqual([`${SITE}@main`]);
	});

	it('answers 422 when the key comes back with a different request', async () => {
		setup();
		const headers = { ...asUser, 'idempotency-key': 'key-12345678' };
		await deploy(headers, 'main');
		const reply = await deploy(headers, 'other');
		expect(reply.status).toBe(422);
		expectEnvelope(reply, 'unprocessable');
		expect(deploys).toHaveLength(1);
	});

	it('never lets two principals replay each other under the same key', async () => {
		setup();
		const key = { 'idempotency-key': 'shared-key-1' };
		const a = await deploy({ ...asUser, ...key });
		const b = await deploy({ ...asOtherUser, ...key });
		expect(a.status).toBe(202);
		expect(b.status).toBe(202);
		expect(b.headers.get('idempotency-replayed')).toBeNull();
		expect(deploys).toHaveLength(2);
		expect((b.json as { operationId: string }).operationId).toBe('op_2');
	});

	it('prefixes every stored key with the principal and the organisation', async () => {
		const seen: string[] = [];
		setup({
			facts: (input) => {
				const base = facts({ ...member('owner'), ...fresh });
				if (input.principal.kind !== 'key') return base;
				return { ...base, key: { id: input.principal.keyId, scopes: ['site.deploy'] } };
			},
			deps: {
				idempotency: {
					get: async (key) => {
						seen.push(key);
						return null;
					},
					put: async (key) => {
						seen.push(key);
					}
				}
			}
		});
		const key = { 'idempotency-key': 'shared-key-1' };
		await deploy({ ...asUser, ...key });
		await deploy({ ...asKey, ...key });
		await send(keysPost, KEY_ROUTE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/keys`,
			headers: { ...asUser, ...key },
			json: { name: 'ci' }
		});
		expect(seen).toEqual([
			`user:user-1|${ORG}|shared-key-1`,
			`user:user-1|${ORG}|shared-key-1`,
			`key:key-1|${ORG}|shared-key-1`,
			`key:key-1|${ORG}|shared-key-1`,
			`user:user-1|${ORG}|shared-key-1`,
			`user:user-1|${ORG}|shared-key-1`
		]);
	});

	it('keeps the same key apart across organisations for one principal', async () => {
		const seen: string[] = [];
		setup({
			facts: (input) =>
				facts({
					membership: { orgId: input.params.orgId ?? ORG, role: 'owner' },
					...fresh
				}),
			deps: {
				idempotency: {
					get: async (key) => {
						seen.push(key);
						return null;
					},
					put: async () => undefined
				}
			}
		});
		const key = { ...asUser, 'idempotency-key': 'shared-key-1' };
		for (const org of ['org-1', 'org-2']) {
			await send(keysPost, KEY_ROUTE, {
				method: 'POST',
				path: `/api/v1/orgs/${org}/keys`,
				headers: key,
				json: { name: 'ci' }
			});
		}
		expect(seen).toEqual(['user:user-1|org-1|shared-key-1', 'user:user-1|org-2|shared-key-1']);
	});

	it('does not store a failed request, so a retry runs the handler again', async () => {
		let calls = 0;
		const route = defineApi(
			{
				...base,
				scope: 'site',
				action: 'site.deploy',
				tags: ['sites'],
				rateClass: 'write',
				params: z.object({ id: z.string() })
			},
			() => {
				calls += 1;
				if (calls === 1) throw new ApiError('conflict', 'busy');
				return { ok: true };
			}
		);
		setup();
		const init = {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: { ...asUser, 'idempotency-key': 'key-12345678' }
		};
		const first = await send(route, DEPLOY_ROUTE, init);
		const second = await send(route, DEPLOY_ROUTE, init);
		expect(first.status).toBe(409);
		expect(second.status).toBe(200);
		expect(calls).toBe(2);
	});

	it('checks authorization again before it replays', async () => {
		let role: 'owner' | 'viewer' = 'owner';
		setup({ facts: () => facts({ ...member(role), ...fresh }) });
		const headers = { ...asUser, 'idempotency-key': 'key-12345678' };
		await deploy(headers);
		role = 'viewer';
		const reply = await deploy(headers);
		expect(reply.status).toBe(403);
		expect(reply.headers.get('idempotency-replayed')).toBeNull();
	});

	it('replays a 204 with no body and ignores the header on a read', async () => {
		let reads = 0;
		const { audits } = setup({
			deps: {
				idempotency: {
					get: async () => {
						reads += 1;
						return null;
					},
					put: async () => undefined
				}
			}
		});
		const read = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: { ...asUser, 'idempotency-key': 'key-12345678' }
		});
		expect(read.status).toBe(200);
		expect(reads).toBe(0);
		expect(audits).toEqual([]);

		setup();
		const init = {
			method: 'DELETE',
			path: `/api/v1/sites/${SITE}`,
			headers: { ...asUser, 'idempotency-key': 'key-12345678' }
		};
		const first = await send(siteDelete, SITE_ROUTE, init);
		const second = await send(siteDelete, SITE_ROUTE, init);
		expect([first.status, first.text]).toEqual([204, '']);
		expect([second.status, second.text]).toEqual([204, '']);
		expect(second.headers.get('idempotency-replayed')).toBe('true');
	});

	it('rejects a malformed key on a write and answers with the idempotency key from a public route', async () => {
		setup();
		const bad = await deploy({ ...asUser, 'idempotency-key': 'short' });
		expect(bad.status).toBe(400);
		expect(deploys).toEqual([]);

		const call = () =>
			send(codePost, '/api/v1/auth/code', {
				method: 'POST',
				path: '/api/v1/auth/code',
				headers: { 'idempotency-key': 'key-12345678', 'cf-connecting-ip': '192.0.2.1' },
				json: { email: 'a@example.test' }
			});
		await call();
		expect((await call()).headers.get('idempotency-replayed')).toBe('true');
	});

	it('still answers when storing the result fails, and logs it', async () => {
		const { errors } = setup({
			deps: {
				idempotency: {
					get: async () => null,
					put: async () => {
						throw new Error('kv down');
					}
				}
			}
		});
		const reply = await deploy({ ...asUser, 'idempotency-key': 'key-12345678' });
		expect(reply.status).toBe(202);
		expect(errors).toHaveLength(1);
	});
});

describe('defineApi: contract versions', () => {
	const call = (headers: Record<string, string> = {}) => {
		setup();
		return send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: { ...asUser, ...headers }
		});
	};

	it('answers 426 with the supported range for a major the server does not serve', async () => {
		const reply = await call({ 'drupflare-contract': 'common=2.0' });
		expect(reply.status).toBe(426);
		expectEnvelope(reply, 'contract_unsupported');
		expect(reply.json).toMatchObject({
			details: { supported: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 0 } } }
		});
		expect(reply.headers.get('drupflare-contract')).toBe('common=1.0');
	});

	it('serves a client range that overlaps and a client that sends no header', async () => {
		expect((await call({ 'drupflare-contract': 'common=1.0-1.3' })).status).toBe(200);
		const bare = await call();
		expect(bare.status).toBe(200);
		expect(bare.headers.get('drupflare-contract')).toBe('common=1.0');
	});

	it('refuses a malformed header and ignores a header for another contract', async () => {
		const bad = await call({ 'drupflare-contract': 'nonsense' });
		expect(bad.status).toBe(400);
		expectEnvelope(bad, 'validation');
		expect((await call({ 'drupflare-contract': 'fleet-link=9.0' })).status).toBe(200);
	});

	it('negotiates before it touches a principal', async () => {
		const { loads, limits } = setup();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: { 'drupflare-contract': 'common=2.0' }
		});
		expect(reply.status).toBe(426);
		expect(loads).toEqual([]);
		expect(limits).toEqual([]);
	});
});

describe('defineApi: errors', () => {
	it('carries the request id on every error and in the X-Request-Id header', async () => {
		const { limits } = setup();
		const cases: Reply[] = [
			await send(siteGet, SITE_ROUTE, { path: `/api/v1/sites/${SITE}` }),
			await send(siteGet, SITE_ROUTE, { path: '/api/v1/sites/site-9', headers: asUser }),
			await send(siteGet, SITE_ROUTE, {
				path: `/api/v1/sites/${SITE}?expand=x`,
				headers: asUser
			})
		];
		expect(cases.map((reply) => reply.status)).toEqual([401, 404, 400]);
		for (const reply of cases) {
			expect(reply.headers.get('x-request-id')).toMatch(/^req_test\d+$/);
			expectEnvelope(reply, (reply.json as { code: string }).code);
		}
		expect(new Set(cases.map((reply) => reply.headers.get('x-request-id'))).size).toBe(3);
		expect(limits).toHaveLength(3);
	});

	it('hides an unexpected failure behind Internal error and logs the original', async () => {
		const route = defineApi({ ...base }, () => {
			throw new Error('password=hunter2 in db.internal');
		});
		const { errors } = setup();
		const reply = await send(route, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(reply.status).toBe(500);
		expectEnvelope(reply, 'internal');
		expect(reply.json).toMatchObject({ message: 'Internal error', details: {} });
		expect(reply.text).not.toContain('hunter2');
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toContain('hunter2');
	});

	it('answers 500 when a handler returns nothing on a route that has a body', async () => {
		const route = defineApi({ ...base }, () => undefined);
		const { errors } = setup();
		const reply = await send(route, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(reply.status).toBe(500);
		expect(errors).toHaveLength(1);
	});

	it('maps typed errors from a handler to their status and shapes details as an object', async () => {
		const route = (details: unknown) =>
			defineApi({ ...base }, () => {
				throw new ApiError('conflict', 'taken', details);
			});
		setup();
		const cases: [unknown, unknown][] = [
			[null, {}],
			[[{ path: 'a' }], { issues: [{ path: 'a' }] }],
			[{ field: 'name' }, { field: 'name' }],
			['text', { value: 'text' }]
		];
		for (const [given, expected] of cases) {
			const reply = await send(route(given), '/api/v1/me', {
				path: '/api/v1/me',
				headers: asUser
			});
			expect(reply.status).toBe(409);
			expect(reply.json).toMatchObject({ details: expected });
			expectEnvelope(reply, 'conflict');
		}
	});
});

describe('defineApi: audit and notification', () => {
	it('audits a write by an organisation member with the organisations from authorize', async () => {
		const { audits, notices } = setup();
		await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: { ref: 'main' }
		});
		expect(audits).toEqual([
			{
				requestId: 'req_test1',
				principal: { kind: 'user', userId: 'user-1' },
				action: 'site.deploy',
				via: 'organisation',
				orgIds: [ORG],
				resource: { orgId: ORG, siteId: SITE, departmentId: 'dept-1' },
				method: 'POST',
				path: `/api/v1/sites/${SITE}/deploys`
			}
		]);
		expect(notices).toEqual([]);
	});

	it('does not audit an ordinary read, and does not audit a request that was refused', async () => {
		const { audits } = setup();
		await send(siteGet, SITE_ROUTE, { path: `/api/v1/sites/${SITE}`, headers: asUser });
		expect(audits).toEqual([]);
		setup({ role: 'viewer' });
		const refused = await send(deployPost, DEPLOY_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}/deploys`,
			headers: asUser,
			json: { ref: 'main' }
		});
		expect(refused.status).toBe(403);
	});

	it('audits a delegated read in both organisations', async () => {
		const created = createDelegation({
			id: 'd1',
			clientOrgId: ORG,
			agencyOrgId: AGENCY,
			role: 'viewer',
			sites: [SITE],
			createdBy: 'client-owner',
			now: NOW - 100
		});
		if (!created.ok) throw new Error(created.reason);
		const accepted = acceptDelegation(created.delegation, { orgId: AGENCY, now: NOW - 50 });
		if (!accepted.ok) throw new Error(accepted.reason);
		const { audits } = setup({
			facts: () =>
				facts({
					delegations: [accepted.delegation],
					agencyMemberships: [{ orgId: AGENCY, role: 'developer' }]
				})
		});
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/sites/${SITE}`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ via: 'delegation', orgIds: [ORG, AGENCY] });
	});

	it('audits break-glass and notifies the owners before the handler runs', async () => {
		const order: string[] = [];
		const route = defineApi(
			{
				...base,
				scope: 'site',
				action: 'site.rollback',
				tags: ['sites'],
				rateClass: 'write',
				params: z.object({ id: z.string() })
			},
			() => {
				order.push('handler');
				return { ok: true };
			}
		);
		setup({
			facts: () =>
				facts({ ...admin, ...fresh, breakGlass: { orgId: ORG, reason: 'site is down' } }),
			deps: {
				audit: async () => {
					order.push('audit');
				},
				notifyOwners: async () => {
					order.push('notify');
				}
			}
		});
		const reply = await send(route, SITE_ROUTE, {
			method: 'POST',
			path: `/api/v1/sites/${SITE}`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(order).toEqual(['audit', 'notify', 'handler']);
	});

	it('passes the break-glass notice and audit record to the collaborators', async () => {
		const route = defineApi(
			{
				...base,
				scope: 'site',
				action: 'site.read',
				tags: ['sites'],
				params: z.object({ id: z.string() })
			},
			() => ({})
		);
		const { audits, notices } = setup({
			facts: () =>
				facts({ ...admin, ...fresh, breakGlass: { orgId: ORG, reason: 'site is down' } })
		});
		await send(route, SITE_ROUTE, { path: `/api/v1/sites/${SITE}`, headers: asUser });
		expect(notices).toEqual([
			{
				requestId: 'req_test1',
				orgId: ORG,
				principal: { kind: 'user', userId: 'user-1' },
				action: 'site.read',
				via: 'break-glass'
			}
		]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ via: 'break-glass', orgIds: [ORG], method: 'GET' });
	});

	it('does not run the handler when the audit write or the owner notice fails', async () => {
		for (const failing of ['audit', 'notifyOwners'] as const) {
			const { errors } = setup({
				facts: () =>
					facts({ ...admin, ...fresh, breakGlass: { orgId: ORG, reason: 'down' } }),
				deps: {
					[failing]: async () => {
						throw new Error(`${failing} failed`);
					}
				}
			});
			let ran = false;
			const route = defineApi(
				{
					...base,
					scope: 'site',
					action: 'site.rollback',
					tags: ['sites'],
					rateClass: 'write',
					params: z.object({ id: z.string() })
				},
				() => {
					ran = true;
					return {};
				}
			);
			const reply = await send(route, SITE_ROUTE, {
				method: 'POST',
				path: `/api/v1/sites/${SITE}`,
				headers: asUser
			});
			expect(reply.status, failing).toBe(500);
			expect(ran, failing).toBe(false);
			expect(errors).toHaveLength(1);
		}
	});
});

describe('defineApi: production defaults', () => {
	it('fail closed: nobody is signed in, and an unbuilt collaborator answers 501', async () => {
		setApiDeps({});
		const anonymous = await send(meGet, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(anonymous.status).toBe(401);

		setApiDeps({ resolvePrincipal: async () => ({ kind: 'user', userId: 'user-1' }) });
		const loaded = await send(meGet, '/api/v1/me', { path: '/api/v1/me', headers: asUser });
		expect(loaded.status).toBe(501);
		expectEnvelope(loaded, 'not_built');

		const deps = productionDeps();
		for (const call of [
			() =>
				deps.load({
					principal: { kind: 'user', userId: 'u' },
					scope: 'session',
					action: 'account.read',
					params: {}
				}),
			() => deps.idempotency.get('k'),
			() => deps.idempotency.put('k', { fingerprint: 'f', status: 200, body: null }),
			() => deps.audit({} as never),
			() => deps.notifyOwners({} as never)
		]) {
			await expect(call()).rejects.toMatchObject({ code: 'not_built' });
		}
	});

	it('limits with the in-memory limiter and mints request ids', async () => {
		const deps = productionDeps();
		const first = await deps.limit({ routeClass: 'auth-code', key: 'ip:1' });
		expect(first).toMatchObject({ allowed: true, limit: 5, remaining: 4 });
		expect(deps.newRequestId()).toMatch(/^req_[0-9a-f]{32}$/);
		expect(deps.newRequestId()).not.toBe(deps.newRequestId());
		expect(deps.maxBodyBytes).toBe(1024 * 1024);
	});
});

describe('defineApi: paging stays inside the organisation', () => {
	const asMemberOfBoth = () =>
		setup({
			facts: (input) =>
				facts({ membership: { orgId: input.params.orgId ?? ORG, role: 'owner' }, ...fresh })
		});

	it('pages one organisation with a cursor that only carries a position', async () => {
		asMemberOfBoth();
		const first = await send(membersGet, MEMBER_ROUTE, {
			path: '/api/v1/orgs/org-1/members?limit=2',
			headers: asUser
		});
		expect(first.json).toMatchObject({ items: [{ id: 'mem_a1' }, { id: 'mem_a2' }] });
		const cursor = (first.json as { nextCursor: string }).nextCursor;
		expect(cursor).toEqual(expect.any(String));
		const next = await send(membersGet, MEMBER_ROUTE, {
			path: `/api/v1/orgs/org-1/members?limit=2&cursor=${cursor}`,
			headers: asUser
		});
		expect(next.json).toEqual({ items: [{ id: 'mem_a3' }], nextCursor: null });
	});

	it('cannot widen another organisation with a cursor taken from the first', async () => {
		asMemberOfBoth();
		const first = await send(membersGet, MEMBER_ROUTE, {
			path: '/api/v1/orgs/org-1/members?limit=2',
			headers: asUser
		});
		const cursor = (first.json as { nextCursor: string }).nextCursor;
		const other = await send(membersGet, MEMBER_ROUTE, {
			path: `/api/v1/orgs/org-2/members?limit=100&cursor=${cursor}`,
			headers: asUser
		});
		const ids = (other.json as { items: { id: string }[] }).items.map((row) => row.id);
		expect(ids).toEqual(['mem_b1', 'mem_b2', 'mem_b3']);
		for (const row of MEMBER_ROWS.filter((r) => r.orgId === 'org-1')) {
			expect(ids).not.toContain(row.id);
		}
	});

	it('refuses a forged cursor with a 400', async () => {
		asMemberOfBoth();
		const reply = await send(membersGet, MEMBER_ROUTE, {
			path: '/api/v1/orgs/org-1/members?cursor=bm90LWpzb24',
			headers: asUser
		});
		expect(reply.status).toBe(400);
	});
});
