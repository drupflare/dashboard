import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import siteHealth from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/health.get';
import {
	resetSiteHealthCache,
	resetSiteHealthServices,
	setSiteHealthServices
} from '../../../../src/server/services/site-health';
import { resetApiDeps, type LoadInput } from '../../../../src/server/utils/define-api';
import { siteHealthSchema } from '../../../../src/shared/health/view';
import { DEPT, facts, fresh, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { ORG, SITE, TOKEN, ok, workerHealth, world } from '../services/site-health-support';

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/health';
const path = (orgId = ORG, id = SITE) => `/api/v1/orgs/${orgId}/sites/${id}/health`;
const STRANGER = 'site_bbbbbbbb';

// the loader answers for the site in the path, and for nothing outside the caller's organisation
function load(options: { role?: 'viewer' | 'owner' | null; scopes?: string[] } = {}) {
	return async (input: LoadInput) => {
		if (input.params.id === STRANGER) return null;
		const role = options.role === undefined ? 'owner' : options.role;
		const base = role === null ? facts({ ...fresh }) : facts({ ...member(role), ...fresh });
		return {
			resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
			facts:
				input.principal.kind === 'key'
					? {
							...base,
							key: { id: 'key-1', scopes: options.scopes ?? ['site.read'] }
						}
					: base
		};
	};
}

beforeEach(() => resetSiteHealthCache());
afterEach(() => {
	resetSiteHealthServices();
	resetApiDeps();
});

describe('GET /api/v1/orgs/{orgId}/sites/{id}/health', () => {
	it('returns the health of the site, matching its declared response', async () => {
		const { errors } = setup({ deps: { load: load() } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(200);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		const out = siteHealthSchema.parse(reply.json);
		expect(out).toMatchObject({ status: 'healthy', level: 'ok', reachable: true });
		expect(reply.text).not.toContain(TOKEN);
		expect(errors).toEqual([]);
	});

	it('answers 200 with not responding when the site is down, never a 500', async () => {
		setup({ deps: { load: load() } });
		const w = await world(() => {
			throw new TypeError(`connect failed for ${TOKEN}`);
		});
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(200);
		expect(siteHealthSchema.parse(reply.json)).toMatchObject({
			status: 'unreachable',
			level: 'error',
			reachable: false
		});
		expect(reply.text).not.toContain(TOKEN);
	});

	it('lets a viewer read it', async () => {
		setup({ deps: { load: load({ role: 'viewer' }) } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(200);
	});

	it('lets a key with site.read read it', async () => {
		setup({ deps: { load: load() } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asKey });

		expect(reply.status).toBe(200);
		expect(w.audits[0]?.actor).toBe('key:key-1');
	});

	it('refuses a key without site.read, before the site is read', async () => {
		const { denials } = setup({ deps: { load: load({ scopes: ['member.read'] }) } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asKey });

		expect(reply.status).toBe(403);
		expect(denials).toHaveLength(1);
		expect(w.fetched).toEqual([]);
		expect(w.audits).toEqual([]);
	});

	it('refuses a person with no relationship to the organisation', async () => {
		setup({ deps: { load: load({ role: null }) } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(403);
		expect(w.fetched).toEqual([]);
	});

	it('finds nothing for a site of another organisation', async () => {
		setup({ deps: { load: load() } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, {
			path: path(ORG, STRANGER),
			headers: asUser
		});

		expect(reply.status).toBe(404);
		expect(w.fetched).toEqual([]);
	});

	it('finds nothing when the organisation in the path is not the site owner', async () => {
		setup({ deps: { load: load() } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, {
			path: path('org_bbbbbbbb'),
			headers: asUser
		});

		expect(reply.status).toBe(404);
		expect(w.fetched).toEqual([]);
	});

	it('refuses before any site call when the resolved site is not the one in the path', async () => {
		const inner = load();
		setup({
			deps: {
				load: async (input) => {
					const loaded = await inner(input);
					return (
						loaded && { ...loaded, resource: { ...loaded.resource, siteId: STRANGER } }
					);
				}
			}
		});
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(404);
		expect(w.db.asked).toEqual([]);
		expect(w.fetched).toEqual([]);
		expect(w.audits).toEqual([]);
	});

	it('requires a sign-in', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(siteHealth, ROUTE, { path: path() });

		expect(reply.status).toBe(401);
	});

	it('rejects an id that is not a site id', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(siteHealth, ROUTE, { path: path(ORG, 'nope'), headers: asUser });

		expect(reply.status).toBe(400);
	});

	it('answers 501 until boot installs the services', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(501);
	});

	it('keeps the read to 15 seconds per site across requests', async () => {
		setup({ deps: { load: load() } });
		const w = await world(() => ok(workerHealth()));
		setSiteHealthServices(w.services);
		await send(siteHealth, ROUTE, { path: path(), headers: asUser });
		await send(siteHealth, ROUTE, { path: path(), headers: asUser });

		expect(w.fetched).toHaveLength(1);
	});
});
