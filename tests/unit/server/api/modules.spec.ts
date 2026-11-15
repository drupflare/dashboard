import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	newOperation as engineOperation,
	freezePlan
} from '../../../../engine/src/operations/state';
import { NEEDS_WORKER_UPDATE } from '../../../../engine/src/workflows/module-remove';
import { NEEDS_THEME_UPDATE } from '../../../../engine/src/workflows/theme-default';
import moduleCheck from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/check.post';
import moduleEnable from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/enable.post';
import moduleSearch from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/index.get';
import moduleInstall from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/install.post';
import moduleRemove from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/remove.post';
import themeDefault from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/modules/theme-default.post';
import { getReadySite } from '../../../../src/server/db/repos/sites';
import {
	checkSiteModule,
	enableSiteModule,
	installSiteModule,
	moduleServices,
	removeSiteModule,
	resetModuleServices,
	searchSiteModules,
	setModuleServices,
	setSiteThemeDefault
} from '../../../../src/server/services/modules';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ApiError } from '../../../../src/shared/errors';
import type { ModuleManifest } from '../../../../src/shared/modules';
import { ORG, OTHER_ORG, SITE } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

// route ids must match the contract's site_ pattern, so the harness learns them here
const ROUTE_SITE = 'site_modules001';
const OTHER_SITE = 'site_other0001';
SITES[ROUTE_SITE] = ORG;
SITES[OTHER_SITE] = OTHER_ORG;

const mocks = vi.hoisted(() => ({
	tokenError: null as Error | null,
	created: true,
	starts: [] as unknown[],
	records: [] as unknown[]
}));

const NOW = 1_790_000_000_000;

vi.mock('../../../../src/server/services/backups', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/backups')>()),
	newOperation: vi.fn(
		async (
			_db: unknown,
			input: { id: string; orgId: string; idempotencyKey: string; plan: never }
		) => {
			mocks.records.push(input);
			const operation = engineOperation({
				id: input.id,
				orgId: input.orgId,
				idempotencyKey: input.idempotencyKey,
				frozen: await freezePlan(input.plan),
				now: NOW
			});
			return { operation: { operation, version: 0 }, created: mocks.created };
		}
	),
	startAndReturn: vi.fn(
		async (_services: unknown, _db: unknown, operation: unknown, request: unknown) => {
			mocks.starts.push(request);
			return operation;
		}
	)
}));

vi.mock('../../../../src/server/db/repos/sites', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/db/repos/sites')>()),
	getReadySite: vi.fn()
}));

vi.mock('../../../../src/server/services/owner-tokens', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/owner-tokens')>()),
	withOwnerToken: vi.fn(
		async (_deps: unknown, _call: unknown, fn: (token: string) => Promise<unknown>) => {
			if (mocks.tokenError) throw mocks.tokenError;
			return fn('owner-token-value');
		}
	)
}));

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/modules';
const BASE = `/api/v1/orgs/${ORG}/sites/${ROUTE_SITE}/modules`;

const census: ModuleManifest = {
	modules: [
		{
			name: 'drupal/token',
			label: 'Token',
			kind: 'unknown',
			state: 'verified',
			shipping: true,
			needs: []
		},
		{
			name: 'drupal/paragraphs',
			label: 'Paragraphs',
			kind: 'unknown',
			state: 'untested',
			shipping: false,
			needs: []
		},
		{
			name: 'drupal/cas',
			label: 'CAS',
			kind: 'unknown',
			state: 'blocked',
			shipping: false,
			reason: 'needs a park',
			needs: []
		},
		{
			name: 'drupal/gin',
			label: 'Gin',
			kind: 'theme',
			state: 'verified',
			shipping: false,
			needs: []
		}
	]
};

const drupalSite = {
	id: SITE,
	kind: 'drupal',
	state: 'active',
	primaryHostname: 'www.example.edu'
};

function reply(status: number, body: unknown): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const base = {
	getDb: async () => ({}) as never,
	custody: async () => ({}) as never,
	fetch: (input: string, init: RequestInit) => fetchMock(input, init),
	timeoutMs: 5_000,
	census: () => census,
	startOperation: async () => undefined,
	routes: { uninstall: false, themeDefault: false },
	restoreCeilingBytes: 16 * 1024 * 1024
};

const input = { orgId: ORG, siteId: SITE, principal: { kind: 'user', userId: 'user-1' } as const };

beforeEach(() => {
	setModuleServices(base);
	vi.mocked(getReadySite).mockResolvedValue(drupalSite as never);
	mocks.tokenError = null;
	mocks.created = true;
	mocks.starts.length = 0;
	mocks.records.length = 0;
	fetchMock.mockReset();
});

afterEach(() => {
	resetModuleServices();
	resetApiDeps();
	vi.clearAllMocks();
});

describe('searchSiteModules', () => {
	it('returns the matching census rows with installed unknown', async () => {
		const { items } = await searchSiteModules(moduleServices(), {
			orgId: ORG,
			siteId: SITE,
			query: { state: 'untested' }
		});
		expect(items.map((item) => item.name)).toEqual(['drupal/paragraphs']);
		expect(items[0]?.installed).toBeNull();
	});

	it('filters to the theme rows when asked for themes', async () => {
		const { items } = await searchSiteModules(moduleServices(), {
			orgId: ORG,
			siteId: SITE,
			query: { kind: 'theme' }
		});
		expect(items.map((item) => item.name)).toEqual(['drupal/gin']);
	});

	it('answers not found for a site the organisation does not hold', async () => {
		vi.mocked(getReadySite).mockResolvedValueOnce(null);
		await expect(
			searchSiteModules(moduleServices(), { orgId: ORG, siteId: 'missing', query: {} })
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('checkSiteModule', () => {
	it('refuses a name that is not on the list without calling the site', async () => {
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/nope' });
		expect(result).toEqual({
			ok: false,
			conflicts: [],
			message: 'That module is not on the list.'
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a blocked module with its reason and never calls the site', async () => {
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/cas' });
		expect(result.message).toBe('needs a park');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a site that is not Drupal', async () => {
		vi.mocked(getReadySite).mockResolvedValueOnce({
			...drupalSite,
			kind: 'wordpress'
		} as never);
		const reply = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(reply.message).toBe('Module checks are for Drupal sites.');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a site with no hostname yet', async () => {
		vi.mocked(getReadySite).mockResolvedValueOnce({
			...drupalSite,
			primaryHostname: null
		} as never);
		const reply = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(reply.message).toBe('This site has no hostname yet.');
	});

	it('says installable when the site answers installable, sending the owner token and no redirect', async () => {
		fetchMock.mockResolvedValueOnce(
			reply(200, { verdict: 'installable', conflicts: [], name: 'drupal/token' })
		);
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result).toEqual({
			ok: true,
			conflicts: [],
			message: 'No conflicts. The site can take this module.'
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('https://www.example.edu/installable?module=drupal%2Ftoken');
		expect(init).toMatchObject({
			method: 'GET',
			redirect: 'manual',
			headers: { authorization: 'Bearer owner-token-value' }
		});
	});

	it('maps a blocked verdict to its conflicts without the composer detail text', async () => {
		fetchMock.mockResolvedValueOnce(
			reply(200, {
				verdict: 'blocked',
				conflicts: [
					{
						requires: 'php',
						constraint: '^8.4',
						installed: '8.3',
						reason: 'version',
						detail: 'internal text'
					}
				]
			})
		);
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.ok).toBe(false);
		expect(result.conflicts).toEqual([
			{ requires: 'php', constraint: '^8.4', installed: '8.3', reason: 'version' }
		]);
		expect(JSON.stringify(result)).not.toContain('internal text');
	});

	it('says no release was found on a 404', async () => {
		fetchMock.mockResolvedValueOnce(reply(404, { verdict: 'not-found' }));
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.message).toBe('No release of this module was found.');
	});

	it('says the requirements cannot be checked for an unverifiable verdict', async () => {
		fetchMock.mockResolvedValueOnce(reply(200, { verdict: 'unverifiable', conflicts: [] }));
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/cannot be checked here/);
	});

	it('refuses a module the runtime cannot run, naming the reason', async () => {
		fetchMock.mockResolvedValueOnce(
			reply(200, {
				verdict: 'installable',
				conflicts: [],
				tier: 'refused',
				reason: 'needs a socket'
			})
		);
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result).toEqual({ ok: false, conflicts: [], message: 'needs a socket' });
	});

	it('says the site could not be read when the answer is not JSON', async () => {
		fetchMock.mockResolvedValueOnce(reply(200, '<html>'));
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.message).toBe('The site answered in a form the dashboard could not read.');
	});

	it('says the site answered with an error on a 500', async () => {
		fetchMock.mockResolvedValueOnce(reply(500, {}));
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.message).toBe('The site answered with an error.');
	});

	it('says the site did not answer when the request fails', async () => {
		fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.message).toBe('The site did not answer.');
	});

	it('refuses plainly when no owner token is stored for the site', async () => {
		mocks.tokenError = new ApiError('not_found', 'No owner token is stored for this site');
		const result = await checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/holds no access/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rethrows an error that is not a missing token', async () => {
		mocks.tokenError = new Error('custody down');
		await expect(
			checkSiteModule(moduleServices(), { ...input, name: 'drupal/token' })
		).rejects.toThrow('custody down');
	});
});

describe('module routes', () => {
	it('answers the search with rows and a null installed flag', async () => {
		setup();
		const res = await send(moduleSearch, ROUTE, {
			path: `${BASE}?state=verified`,
			headers: asUser
		});
		expect(res.status).toBe(200);
		const items = (res.json as { items: { name: string; installed: unknown }[] }).items;
		expect(items.map((item) => item.name)).toEqual(['drupal/token', 'drupal/gin']);
		expect(items.every((item) => item.installed === null)).toBe(true);
	});

	it('answers the check with the verdict for a name in the body', async () => {
		setup();
		fetchMock.mockResolvedValueOnce(reply(200, { verdict: 'installable', conflicts: [] }));
		const res = await send(moduleCheck, `${ROUTE}/check`, {
			method: 'POST',
			path: `${BASE}/check`,
			headers: asUser,
			json: { name: 'drupal/token' }
		});
		expect(res.status).toBe(200);
		expect(res.json).toEqual({
			ok: true,
			conflicts: [],
			message: 'No conflicts. The site can take this module.'
		});
	});

	it('refuses a check body with an unknown field', async () => {
		setup();
		const res = await send(moduleCheck, `${ROUTE}/check`, {
			method: 'POST',
			path: `${BASE}/check`,
			headers: asUser,
			json: { name: 'drupal/token', extra: true }
		});
		expect(res.status).toBe(400);
	});

	it('refuses a site of another organisation at the authorisation gate', async () => {
		setup();
		const res = await send(moduleSearch, ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/${OTHER_SITE}/modules`,
			headers: asUser
		});
		expect(res.status).toBe(403);
	});
});

// #region the changes

const change = { orgId: ORG, siteId: SITE, idempotencyKey: 'key-0001', operationId: 'op_aaaaaaaa' };

describe('installSiteModule', () => {
	it('starts the install with the restore point named as the rollback point', async () => {
		const operation = await installSiteModule(moduleServices(), {
			...change,
			name: 'drupal/gin',
			confirm: false
		});
		expect(operation.operation.id).toBe('op_aaaaaaaa');
		const record = mocks.records[0] as {
			type: string;
			plan: { rollbackPoint: string | null };
			inputs: { backupId: string; name: string; confirm: boolean; census: { state: string } };
		};
		expect(record.type).toBe('module.install');
		expect(record.plan.rollbackPoint).toBe(record.inputs.backupId);
		expect(record.inputs).toMatchObject({
			name: 'drupal/gin',
			confirm: false,
			census: { state: 'verified', shipping: false }
		});
		expect(mocks.starts[0]).toMatchObject({ workflow: 'module-install', id: 'op_aaaaaaaa' });
	});

	it('starts nothing for a repeat of the same key', async () => {
		mocks.created = false;
		await installSiteModule(moduleServices(), {
			...change,
			name: 'drupal/gin',
			confirm: false
		});
		expect(mocks.starts).toEqual([]);
	});

	it('refuses an untested module until the owner confirms it', async () => {
		await expect(
			installSiteModule(moduleServices(), {
				...change,
				name: 'drupal/paragraphs',
				confirm: false
			})
		).rejects.toMatchObject({
			code: 'unprocessable',
			details: { reason: 'needs_confirmation' }
		});
		expect(mocks.records).toEqual([]);
		await installSiteModule(moduleServices(), {
			...change,
			name: 'drupal/paragraphs',
			confirm: true
		});
		expect(mocks.starts).toHaveLength(1);
	});

	it.each([
		['a blocked module', 'drupal/cas', 'needs a park'],
		['a name that is not on the list', 'drupal/nope', 'That module is not on the list.']
	])('refuses %s without starting anything', async (_label, name, message) => {
		await expect(
			installSiteModule(moduleServices(), { ...change, name, confirm: true })
		).rejects.toMatchObject({ code: 'unprocessable', message });
		expect(mocks.records).toEqual([]);
		expect(mocks.starts).toEqual([]);
	});

	it('refuses a site that is not Drupal, one that is not active, and one that is not found', async () => {
		vi.mocked(getReadySite).mockResolvedValueOnce({
			...drupalSite,
			kind: 'wordpress'
		} as never);
		await expect(
			installSiteModule(moduleServices(), { ...change, name: 'drupal/token', confirm: false })
		).rejects.toMatchObject({ details: { reason: 'not_drupal' } });
		vi.mocked(getReadySite).mockResolvedValueOnce({
			...drupalSite,
			state: 'creating',
			accountId: 'a'
		} as never);
		await expect(
			installSiteModule(moduleServices(), { ...change, name: 'drupal/token', confirm: false })
		).rejects.toMatchObject({ details: { reason: 'site_not_active' } });
		vi.mocked(getReadySite).mockResolvedValueOnce(null);
		await expect(
			installSiteModule(moduleServices(), { ...change, name: 'drupal/token', confirm: false })
		).rejects.toMatchObject({ code: 'not_found' });
		expect(mocks.records).toEqual([]);
	});
});

describe('enableSiteModule', () => {
	it('starts the enable for a module on the list', async () => {
		await enableSiteModule(moduleServices(), { ...change, name: 'drupal/token' });
		expect(mocks.starts[0]).toMatchObject({ workflow: 'module-enable' });
	});

	it('refuses a blocked module and one on no list', async () => {
		await expect(
			enableSiteModule(moduleServices(), { ...change, name: 'drupal/cas' })
		).rejects.toMatchObject({ message: 'needs a park' });
		await expect(
			enableSiteModule(moduleServices(), { ...change, name: 'drupal/nope' })
		).rejects.toMatchObject({ message: 'That module is not on the list.' });
		expect(mocks.starts).toEqual([]);
	});
});

describe('removeSiteModule', () => {
	it('refuses a module in the pack with the guard reason, before the site is asked', async () => {
		setModuleServices({ routes: { uninstall: true, themeDefault: true } });
		await expect(
			removeSiteModule(moduleServices(), { ...change, name: 'drupal/token' })
		).rejects.toMatchObject({
			message: 'Token is included with every site and cannot be removed.',
			details: { reason: 'removal_refused' }
		});
		expect(mocks.starts).toEqual([]);
	});

	it('answers the plain refusal while the site has no removal route', async () => {
		await expect(
			removeSiteModule(moduleServices(), { ...change, name: 'drupal/paragraphs' })
		).rejects.toMatchObject({
			code: 'unprocessable',
			message: NEEDS_WORKER_UPDATE,
			details: { reason: 'needs_worker_update' }
		});
		expect(mocks.records).toEqual([]);
	});

	it('starts the removal once the site has the route', async () => {
		setModuleServices({ routes: { uninstall: true, themeDefault: false } });
		await removeSiteModule(moduleServices(), { ...change, name: 'drupal/paragraphs' });
		expect(mocks.starts[0]).toMatchObject({ workflow: 'module-remove' });
	});
});

describe('setSiteThemeDefault', () => {
	it('answers the plain refusal while the site has no theme route', async () => {
		await expect(
			setSiteThemeDefault(moduleServices(), {
				...change,
				name: 'drupal/gin',
				target: 'default'
			})
		).rejects.toMatchObject({
			message: NEEDS_THEME_UPDATE,
			details: { reason: 'needs_worker_update' }
		});
		expect(mocks.records).toEqual([]);
	});

	it('starts the change once the site has the route', async () => {
		setModuleServices({ routes: { uninstall: false, themeDefault: true } });
		await setSiteThemeDefault(moduleServices(), {
			...change,
			name: 'drupal/gin',
			target: 'admin'
		});
		expect(mocks.starts[0]).toMatchObject({
			workflow: 'theme-default',
			params: { target: 'admin', name: 'drupal/gin' }
		});
	});

	it('refuses a blocked theme and one on no list', async () => {
		setModuleServices({ routes: { uninstall: false, themeDefault: true } });
		await expect(
			setSiteThemeDefault(moduleServices(), {
				...change,
				name: 'drupal/cas',
				target: 'default'
			})
		).rejects.toMatchObject({ message: 'needs a park' });
		await expect(
			setSiteThemeDefault(moduleServices(), {
				...change,
				name: 'drupal/nope',
				target: 'default'
			})
		).rejects.toMatchObject({ message: 'That theme is not on the list.' });
	});
});

describe('the change routes', () => {
	const post = (
		handler: Parameters<typeof send>[0],
		tail: string,
		json: unknown,
		key = 'key-route-1'
	) =>
		send(handler, `${ROUTE}/${tail}`, {
			method: 'POST',
			path: `${BASE}/${tail}`,
			headers: { ...asUser, 'idempotency-key': key },
			json
		});

	it('starts an install and answers 202 with the operation', async () => {
		setup();
		const res = await post(moduleInstall, 'install', { name: 'drupal/gin' });
		expect(res.status).toBe(202);
		expect(res.json).toMatchObject({ type: 'module.install', status: 'planned' });
	});

	it('starts an enable and answers 202', async () => {
		setup();
		const res = await post(moduleEnable, 'enable', { name: 'drupal/token' });
		expect(res.status).toBe(202);
		expect(res.json).toMatchObject({ type: 'module.enable' });
	});

	it('answers 422 with the plain refusal for a removal and a theme change today', async () => {
		setup();
		const removal = await post(moduleRemove, 'remove', { name: 'drupal/paragraphs' });
		expect(removal.status).toBe(422);
		expect(JSON.stringify(removal.json)).toContain(NEEDS_WORKER_UPDATE);
		const theme = await post(themeDefault, 'theme-default', {
			name: 'drupal/gin',
			target: 'default'
		});
		expect(theme.status).toBe(422);
		expect(JSON.stringify(theme.json)).toContain(NEEDS_THEME_UPDATE);
	});

	it('answers 422 for an untested module without confirm', async () => {
		setup();
		const res = await post(moduleInstall, 'install', { name: 'drupal/paragraphs' });
		expect(res.status).toBe(422);
		expect(JSON.stringify(res.json)).toContain('needs_confirmation');
	});

	it('requires an Idempotency-Key header', async () => {
		setup();
		const res = await send(moduleInstall, `${ROUTE}/install`, {
			method: 'POST',
			path: `${BASE}/install`,
			headers: asUser,
			json: { name: 'drupal/token' }
		});
		expect(res.status).toBe(400);
		expect(mocks.records).toEqual([]);
	});

	it('refuses a body with an unknown field and a theme target that is not default or admin', async () => {
		setup();
		expect(
			(await post(moduleInstall, 'install', { name: 'drupal/token', extra: 1 })).status
		).toBe(400);
		expect(
			(await post(themeDefault, 'theme-default', { name: 'drupal/gin', target: 'front' }))
				.status
		).toBe(400);
	});

	it('refuses a site of another organisation at the authorisation gate', async () => {
		setup();
		const res = await send(moduleInstall, `${ROUTE}/install`, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites/${OTHER_SITE}/modules/install`,
			headers: { ...asUser, 'idempotency-key': 'key-route-2' },
			json: { name: 'drupal/token' }
		});
		expect(res.status).toBe(403);
	});
});

// #endregion
