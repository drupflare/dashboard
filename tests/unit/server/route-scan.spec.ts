import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	API_ROOT,
	isAllowListed,
	listRouteFiles,
	scanRoutes,
	type RouteEntry
} from '../../../scripts/gen-openapi';
import { authorize, type Facts } from '../../../src/server/domain/authorize';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import {
	ACTIONS,
	ORG_ROLES,
	ORG_ROLE_ACTIONS,
	SITE_ROLES,
	SITE_ROLE_ACTIONS,
	actionDef,
	isAction,
	isPublicAction,
	isSessionOnly,
	type Action
} from '../../../src/shared/permissions';
import { DEPT, ORG, SITE, facts, fresh, member, resource, user } from '../domain/fixtures';
import { send } from './fixtures/harness';

const FIXTURES = join(import.meta.dirname, 'fixtures/api');
const BAD_FIXTURES = join(import.meta.dirname, 'fixtures/bad-api');
const ROOT = join(import.meta.dirname, '../../..');

afterEach(() => resetApiDeps());

function decide(action: Action, f: Facts): string {
	const d = authorize({ principal: user, action, resource, facts: f });
	return d.allow ? 'allow' : d.reason;
}

// every action a route declares, walked against every role with the same data the table uses
function walk(routes: readonly RouteEntry[]) {
	const actions = [...new Set(routes.map((route) => route.meta.action))].filter(isAction);
	for (const action of actions) {
		const def = actionDef(action);
		if (def.scope === 'admin' || def.scope === 'account') continue;
		for (const role of ORG_ROLES) {
			const want = ORG_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
			expect(decide(action, facts({ ...member(role), ...fresh })), `${role} ${action}`).toBe(
				want
			);
		}
		if (def.scope === 'site') {
			for (const role of SITE_ROLES) {
				const f = facts({
					...fresh,
					grants: [{ level: 'site', orgId: ORG, targetId: SITE, role }]
				});
				const want = SITE_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
				expect(decide(action, f), `site ${role} ${action}`).toBe(want);
			}
		}
		for (const role of ORG_ROLES) {
			const grants = [{ level: 'department', orgId: ORG, targetId: DEPT, role }] as const;
			const below = def.scope !== 'org';
			const want = below && ORG_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
			expect(decide(action, facts({ ...fresh, grants })), `dept ${role} ${action}`).toBe(
				want
			);
		}
		expect(decide(action, facts({ ...fresh })), `stranger ${action}`).toBe('not_a_member');
	}
	return actions;
}

describe('route scan: src/server/api', () => {
	it('finds every route file defined with defineApi and an action in the permission table', async () => {
		const { routes, problems } = await scanRoutes(API_ROOT);
		expect(problems).toEqual([]);
		for (const route of routes) {
			const known =
				route.meta.scope === 'public'
					? isPublicAction(route.meta.action)
					: isAction(route.meta.action);
			expect(known, route.rel).toBe(true);
		}
		const files = listRouteFiles(API_ROOT).filter((rel) => !isAllowListed(rel));
		expect(routes.map((route) => route.rel)).toEqual(files);
	});

	it('walks every extracted action against every role', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		walk(routes);
	});

	it('keeps the allow-list to files that exist', () => {
		const files = listRouteFiles(API_ROOT);
		for (const rel of ['health.get.ts', 'index.get.ts', 'openapi.json.get.ts']) {
			expect(files, rel).toContain(rel);
			expect(isAllowListed(rel), rel).toBe(true);
		}
	});

	it('allows the hooks folder and nothing nested under another name', () => {
		expect(isAllowListed('hooks/stripe.post.ts')).toBe(true);
		expect(isAllowListed('hooks.get.ts')).toBe(false);
		expect(isAllowListed('v1/index.get.ts')).toBe(false);
		expect(isAllowListed('v1/hooks/stripe.post.ts')).toBe(false);
		expect(isAllowListed('v1/health.get.ts')).toBe(false);
	});
});

// a handler must take the organisation and the site from ctx.resource, which the loader built from
// rows. Comparing a path value with the resource is allowed; using it is not
function requestInputReads(scope: string, source: string): string[] {
	const found: string[] = [];
	const pathId = scope === 'site' ? 'id' : scope === 'organization' ? 'orgId' : null;
	if (pathId !== null) {
		const used = source
			.replace(new RegExp(`(?:!==|===)\\s*params\\.${pathId}\\b`, 'g'), '')
			.replace(new RegExp(`\\bparams\\.${pathId}\\s*(?:!==|===)`, 'g'), '');
		if (new RegExp(`\\bparams\\.${pathId}\\b`).test(used)) found.push(`params.${pathId}`);
	}
	if (scope === 'site' || scope === 'organization') {
		for (const hit of source.matchAll(/\b(?:body|query)\.(?:orgId|organizationId|siteId)\b/g)) {
			found.push(hit[0]);
		}
	}
	return found;
}

describe('route scan: organisation and site come from the resource', () => {
	it('flags a path value used as an organisation or a site, and a body or query id', () => {
		expect(requestInputReads('site', 'get(db, resource.orgId, params.id)')).toEqual([
			'params.id'
		]);
		expect(requestInputReads('organization', 'use(params.orgId)')).toEqual(['params.orgId']);
		expect(requestInputReads('organization', 'x(body.orgId, query.siteId)')).toEqual([
			'body.orgId',
			'query.siteId'
		]);
		expect(requestInputReads('site', 'x(body.organizationId)')).toEqual([
			'body.organizationId'
		]);
	});

	it('allows a comparison with the resource, another resource id and unscoped routes', () => {
		expect(
			requestInputReads('organization', 'if (resource.orgId !== params.orgId) fail()')
		).toEqual([]);
		expect(requestInputReads('site', 'if (params.id === resource.siteId) ok()')).toEqual([]);
		expect(requestInputReads('organization', 'get(resource.orgId, params.id)')).toEqual([]);
		expect(requestInputReads('session', 'x(params.id, body.orgId)')).toEqual([]);
		expect(requestInputReads('public', 'x(params.orgId)')).toEqual([]);
	});

	it('finds no handler that reads one after the loader has produced the resource', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		const offenders = routes.flatMap((route) =>
			requestInputReads(
				route.meta.scope,
				readFileSync(join(API_ROOT, route.rel), 'utf8')
			).map((read) => `${route.rel}: ${read}`)
		);
		expect(offenders).toEqual([]);
	});
});

describe('route scan: live route tree', () => {
	it('gives every live route file a method and path that no other file claims', async () => {
		const { routes, problems } = await scanRoutes(API_ROOT);
		expect(problems).toEqual([]);
		const keys = routes.map((route) => `${route.method} ${route.path}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toEqual(expect.arrayContaining(['get /api/v1/me', 'get /api/v1/templates']));
	});

	it('finds the capacity route as an admin route with its own action', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		const route = routes.find((found) => found.path === '/api/v1/admin/capacity');
		expect(route?.method).toBe('get');
		expect(route?.meta).toMatchObject({ scope: 'admin', action: 'admin.capacity.read' });
	});

	it('finds the repository routes, each with an action that holds the right roles', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		const found = Object.fromEntries(
			routes
				.filter((route) => /repo-connections|\/remotes$/.test(route.path))
				.map((route) => [`${route.method} ${route.path}`, route.meta.action])
		);
		expect(found).toEqual({
			'get /api/v1/orgs/{orgId}/repo-connections': 'repo.read',
			'post /api/v1/orgs/{orgId}/repo-connections': 'repo.connect',
			'post /api/v1/orgs/{orgId}/repo-connections/complete': 'repo.connect',
			'get /api/v1/orgs/{orgId}/repo-connections/{id}/repositories': 'repo.read',
			'post /api/v1/orgs/{orgId}/repo-connections/{id}/revoke': 'repo.connect',
			'get /api/v1/orgs/{orgId}/sites/{id}/remotes': 'site.read',
			'post /api/v1/orgs/{orgId}/sites/{id}/remotes': 'site.remote.manage'
		});
		expect(ORG_ROLE_ACTIONS.developer).not.toContain('repo.connect');
		expect(ORG_ROLE_ACTIONS.admin).toContain('repo.connect');
		expect(isSessionOnly('repo.connect')).toBe(true);
	});

	it('lists the GitHub hook as a file outside the scan, beside the Stripe hook', () => {
		expect(isAllowListed('hooks/github.post.ts')).toBe(true);
		expect(listRouteFiles(API_ROOT)).toContain('hooks/github.post.ts');
	});

	it('gives every live route a non-empty action in the permission table', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		for (const route of routes) {
			expect(route.meta.action.length, route.rel).toBeGreaterThan(0);
			const known =
				route.meta.scope === 'public'
					? isPublicAction(route.meta.action)
					: isAction(route.meta.action);
			expect(known, route.rel).toBe(true);
		}
	});
});

describe('route scan: sample routes', () => {
	it('maps file names to methods and paths and reads every scope', async () => {
		const { routes, problems } = await scanRoutes(FIXTURES);
		expect(problems).toEqual([]);
		expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
			'get /api/v1/admin/aggregates',
			'post /api/v1/auth/code',
			'get /api/v1/me',
			'post /api/v1/orgs/{orgId}/keys',
			'get /api/v1/orgs/{orgId}/members',
			'post /api/v1/sites/{id}/deploys',
			'delete /api/v1/sites/{id}',
			'get /api/v1/sites/{id}'
		]);
		expect(new Set(routes.map((route) => route.meta.scope))).toEqual(
			new Set(['public', 'session', 'organization', 'site', 'admin'])
		);
	});

	it('walks every extracted action against every role and refuses a key on session-only ones', async () => {
		const { routes } = await scanRoutes(FIXTURES);
		const actions = walk(routes);
		expect(actions).toEqual(
			expect.arrayContaining([
				'site.read',
				'site.deploy',
				'site.delete',
				'member.read',
				'key.create'
			])
		);
		for (const action of ACTIONS) {
			const key = { id: 'key-1', scopes: ACTIONS };
			const d = authorize({
				principal: { kind: 'key', keyId: 'key-1', issuerId: 'user-1' },
				action,
				resource,
				facts: facts({ ...member('owner'), ...fresh, key })
			});
			if (isSessionOnly(action) || actionDef(action).stepUp)
				expect(d.allow, action).toBe(false);
		}
	});

	it('reports each way a route file can break the rules', async () => {
		const { routes, problems } = await scanRoutes(BAD_FIXTURES);
		expect(routes).toEqual([]);
		expect(problems.sort()).toEqual(
			[
				expect.stringContaining(
					'unversioned.get.ts: route files outside the allow-list must live under v1/'
				),
				expect.stringContaining('v1/nomethod.ts: file name needs a method suffix'),
				expect.stringContaining(
					'v1/params.get.ts: params must match the path (missing none, extra id)'
				),
				expect.stringContaining(
					'v1/plain.get.ts: the default export is not a defineApi result'
				),
				expect.stringMatching(
					/v1\/unregistered\.get\.ts: failed to import: .*site\.explode/
				)
			].sort()
		);
	});
});

describe('route scan: documentation routes', () => {
	it('serves the Swagger page with a CSP that names the one inline script by hash', async () => {
		const page = (await import('../../../src/server/api/index.get')).default;
		const reply = await send(page, '/api', { path: '/api' });
		expect(reply.status).toBe(200);
		expect(reply.headers.get('content-type')).toContain('text/html');
		const inline = /<script>([^<]+)<\/script>/.exec(reply.text)?.[1];
		expect(inline).toContain("url: '/api/openapi.json'");
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inline));
		const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
		const csp = reply.headers.get('content-security-policy') ?? '';
		expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
		expect(csp).not.toContain('unsafe');
		for (const directive of [
			"default-src 'none'",
			"frame-ancestors 'none'",
			"base-uri 'none'"
		]) {
			expect(csp).toContain(directive);
		}
	});

	it('loads every script and style from the pinned asset path on this origin', async () => {
		const page = (await import('../../../src/server/api/index.get')).default;
		const reply = await send(page, '/api', { path: '/api' });
		const sources = [...reply.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
		expect(sources).toEqual([
			'/api/swagger-ui/swagger-ui.css',
			'/api/swagger-ui/swagger-ui-bundle.js'
		]);
	});

	it('serves the committed OpenAPI document as JSON', async () => {
		const route = (await import('../../../src/server/api/openapi.json.get')).default;
		const reply = await send(route, '/api/openapi.json', { path: '/api/openapi.json' });
		expect(reply.status).toBe(200);
		expect(reply.headers.get('content-type')).toContain('application/json');
		const committed = JSON.parse(readFileSync(join(ROOT, 'contracts/openapi.json'), 'utf8'));
		expect(reply.json).toEqual(committed);
		expect(reply.headers.get('cache-control')).toContain('max-age');
	});
});
