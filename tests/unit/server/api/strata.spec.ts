import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	newOperation as engineOperation,
	freezePlan
} from '../../../../engine/src/operations/state';
import strataGet from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/strata.get';
import strataPut from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/strata.put';
import {
	getSiteStrata,
	saveSiteStrata,
	selfManagedStorageCheck
} from '../../../../src/server/db/repos/site-strata';
import { getReadySite } from '../../../../src/server/db/repos/sites';
import { derive } from '../../../../src/server/domain/entitlements';
import {
	enableSiteModule,
	getStrataStatus,
	moduleServices,
	resetModuleServices,
	setModuleServices,
	setStrataAllocation
} from '../../../../src/server/services/modules';
import { withOwnerToken } from '../../../../src/server/services/owner-tokens';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ApiError } from '../../../../src/shared/errors';
import type { ModuleManifest } from '../../../../src/shared/modules';
import { STRATA_FREE_REASON, STRATA_MODULE } from '../../../../src/shared/strata';
import { ORG, SITE } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

const ROUTE_SITE = 'site_strata0001';
SITES[ROUTE_SITE] = ORG;

const NOW = 1_790_000_000_000;

const kept = vi.hoisted(() => ({
	rows: new Map<string, Record<string, unknown>>()
}));

vi.mock('../../../../src/server/services/backups', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/backups')>()),
	newOperation: vi.fn(
		async (
			_db: unknown,
			input: { id: string; orgId: string; idempotencyKey: string; plan: never }
		) => ({
			operation: {
				operation: engineOperation({
					id: input.id,
					orgId: input.orgId,
					idempotencyKey: input.idempotencyKey,
					frozen: await freezePlan(input.plan),
					now: NOW
				}),
				version: 0
			},
			created: true
		})
	),
	startAndReturn: vi.fn(async (_s: unknown, _d: unknown, operation: unknown) => operation)
}));

vi.mock('../../../../src/server/services/owner-tokens', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/owner-tokens')>()),
	withOwnerToken: vi.fn(
		async (_deps: unknown, _call: unknown, fn: (token: string) => Promise<unknown>) =>
			fn('owner-token')
	)
}));

vi.mock('../../../../src/server/db/repos/sites', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/db/repos/sites')>()),
	getReadySite: vi.fn()
}));

vi.mock('../../../../src/server/db/repos/site-strata', () => ({
	selfManagedStorageCheck: vi.fn(async () => 'needs_wider_token'),
	getSiteStrata: vi.fn(async (_db: unknown, _org: string, siteId: string) => {
		const row = kept.rows.get(siteId);
		return row ?? null;
	}),
	markStrataApplied: vi.fn(
		async (_db: unknown, next: { siteId: string; allocation: string; now: number }) => {
			const row = kept.rows.get(next.siteId);
			if (row && row.allocation === next.allocation) row.appliedAt = next.now;
		}
	),
	saveSiteStrata: vi.fn(
		async (
			_db: unknown,
			next: {
				organizationId: string;
				siteId: string;
				allocation: string;
				confirmedFreeAt?: number;
				now: number;
			}
		) => {
			const before = kept.rows.get(next.siteId) as { confirmedFreeAt?: number } | undefined;
			kept.rows.set(next.siteId, {
				siteId: next.siteId,
				organizationId: next.organizationId,
				allocation: next.allocation,
				appliedAt: null,
				confirmedFreeAt: next.confirmedFreeAt ?? before?.confirmedFreeAt ?? null,
				updatedAt: next.now
			});
		}
	)
}));

const census: ModuleManifest = {
	modules: [
		{
			name: STRATA_MODULE,
			label: 'Strata',
			kind: 'unknown',
			state: 'verified',
			shipping: false,
			needs: []
		},
		{
			name: 'drupal/token',
			label: 'Token',
			kind: 'unknown',
			state: 'verified',
			shipping: true,
			needs: []
		}
	]
};

const entitlement = (plan: string) => {
	const result = derive(plan);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

const audits: { action: string; detail?: unknown }[] = [];
let plan = 'managed-free';

const base = {
	getDb: async () => ({}) as never,
	custody: async () => ({}) as never,
	fetch: (async () => new Response('{}')) as never,
	timeoutMs: 5_000,
	census: () => census,
	startOperation: async () => undefined,
	routes: { uninstall: false, themeDefault: false },
	restoreCeilingBytes: 16 * 1024 * 1024,
	planOf: async () => entitlement(plan),
	audit: async (_org: string, input: { action: string; detail?: unknown }) => {
		audits.push(input);
	},
	now: () => NOW
};

const change = {
	orgId: ORG,
	siteId: SITE,
	idempotencyKey: 'key-0001',
	operationId: 'op_aaaaaaaa',
	actor: 'user:user-1'
};

beforeEach(() => {
	plan = 'managed-free';
	kept.rows.clear();
	audits.length = 0;
	setModuleServices(base);
	vi.mocked(getReadySite).mockResolvedValue({
		id: SITE,
		kind: 'drupal',
		plane: 'managed',
		state: 'active',
		accountId: 'acct_1',
		primaryHostname: 'www.example.edu'
	} as never);
});

afterEach(() => {
	resetModuleServices();
	resetApiDeps();
	vi.clearAllMocks();
});

describe('Strata on the free plan', () => {
	it('refuses the enable until the owner confirms the warning', async () => {
		await expect(
			enableSiteModule(moduleServices(), { ...change, name: STRATA_MODULE })
		).rejects.toMatchObject({
			code: 'unprocessable',
			details: { reason: 'needs_confirmation', warning: STRATA_FREE_REASON }
		});
		expect(saveSiteStrata).not.toHaveBeenCalled();
	});

	it('records the confirmation once and audits it, then stops asking', async () => {
		await enableSiteModule(moduleServices(), { ...change, name: STRATA_MODULE, confirm: true });
		expect(audits.map((entry) => entry.action)).toEqual(['site.strata.confirm_free']);
		expect(kept.rows.get(SITE)).toMatchObject({ allocation: 'light', confirmedFreeAt: NOW });

		await expect(
			enableSiteModule(moduleServices(), {
				...change,
				idempotencyKey: 'key-0002',
				operationId: 'op_bbbbbbbb',
				name: STRATA_MODULE
			})
		).resolves.toBeDefined();
		expect(audits).toHaveLength(1);
	});

	it('never asks for a confirmation on another module', async () => {
		await expect(
			enableSiteModule(moduleServices(), { ...change, name: 'drupal/token' })
		).resolves.toBeDefined();
		expect(getSiteStrata).not.toHaveBeenCalled();
	});

	it('keeps the allocation on light', async () => {
		await expect(
			setStrataAllocation(moduleServices(), {
				orgId: ORG,
				siteId: SITE,
				allocation: 'detailed',
				actor: 'user:user-1'
			})
		).rejects.toMatchObject({ details: { reason: 'allocation_not_allowed' } });
		expect(saveSiteStrata).not.toHaveBeenCalled();
	});
});

describe('Strata on a paid plan', () => {
	beforeEach(() => {
		plan = 'managed-pro';
	});

	it('enables without a confirmation and starts on light', async () => {
		await enableSiteModule(moduleServices(), { ...change, name: STRATA_MODULE });
		expect(kept.rows.get(SITE)).toMatchObject({
			allocation: 'light',
			confirmedFreeAt: null
		});
		expect(audits).toEqual([]);
	});

	it('changes the allocation, audits the change and reports it as not yet accepted', async () => {
		const status = await setStrataAllocation(moduleServices(), {
			orgId: ORG,
			siteId: SITE,
			allocation: 'detailed',
			actor: 'user:user-1'
		});
		expect(status).toEqual({
			allocation: 'detailed',
			capturesStatements: true,
			recoverySeconds: 900,
			applied: false,
			confirmedFreeAt: null,
			store: 'none',
			storeReason: null,
			storage: null
		});
		expect(audits).toEqual([
			{
				actor: 'user:user-1',
				action: 'site.strata.allocation',
				target: SITE,
				detail: { from: null, to: 'detailed' }
			}
		]);
	});

	it('writes no audit row when the allocation does not change', async () => {
		kept.rows.set(SITE, { allocation: 'light', appliedAt: null, confirmedFreeAt: null });
		await setStrataAllocation(moduleServices(), {
			orgId: ORG,
			siteId: SITE,
			allocation: 'light',
			actor: 'user:user-1'
		});
		expect(audits).toEqual([]);
		expect(saveSiteStrata).not.toHaveBeenCalled();
	});

	describe('applying to the site', () => {
		const choose = (allocation: 'light' | 'detailed') =>
			setStrataAllocation(moduleServices(), {
				orgId: ORG,
				siteId: SITE,
				allocation,
				actor: 'user:user-1'
			});
		const answering = (status: number, body: unknown) => {
			const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
			setModuleServices({ ...base, fetch: fetch as never });
			return fetch;
		};

		it('posts the setting to the site and marks it applied when the site answers with it', async () => {
			const fetch = answering(200, {
				captureStatements: true,
				previous: false,
				applied: true
			});
			const status = await choose('detailed');

			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe('https://www.example.edu/strata-config');
			expect(init.method).toBe('POST');
			expect(init.body).toBe('{"captureStatements":true}');
			expect(init.redirect).toBe('manual');
			expect(status).toMatchObject({ allocation: 'detailed', applied: true });
			expect(kept.rows.get(SITE)).toMatchObject({ appliedAt: NOW });
		});

		it('sends false for light', async () => {
			const fetch = answering(200, { captureStatements: false, applied: true });
			await expect(choose('light')).resolves.toMatchObject({ applied: true });
			const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(init.body).toBe('{"captureStatements":false}');
		});

		it.each([
			['Strata is not on the site', 409, { error: 'strata_not_enabled' }],
			['the site has no such route', 404, {}],
			['the site fails', 500, {}],
			['the site answers another value', 200, { captureStatements: false }],
			['the site answers something unreadable', 200, { ok: true }]
		])('leaves the choice unapplied when %s', async (_name, code, body) => {
			answering(code, body);
			await expect(choose('detailed')).resolves.toMatchObject({
				allocation: 'detailed',
				applied: false
			});
			expect(kept.rows.get(SITE)).toMatchObject({ appliedAt: null });
		});

		it('leaves the choice unapplied when the site does not answer', async () => {
			const fetch = vi.fn(async () => {
				throw new Error('timed out');
			});
			setModuleServices({ ...base, fetch: fetch as never });
			await expect(choose('detailed')).resolves.toMatchObject({ applied: false });
		});

		it('tries again when the same setting is chosen while it is unapplied', async () => {
			answering(500, {});
			await choose('detailed');
			const retry = answering(200, { captureStatements: true, applied: true });
			await expect(choose('detailed')).resolves.toMatchObject({ applied: true });
			expect(retry).toHaveBeenCalledTimes(1);
			expect(audits).toHaveLength(1);
		});

		it('does not call the site again for a setting it already accepted', async () => {
			kept.rows.set(SITE, { allocation: 'light', appliedAt: NOW, confirmedFreeAt: null });
			const fetch = answering(200, { captureStatements: false });
			await expect(choose('light')).resolves.toMatchObject({ applied: true });
			expect(fetch).not.toHaveBeenCalled();
		});

		it('does not call a site that is not active', async () => {
			vi.mocked(getReadySite).mockResolvedValue({
				id: SITE,
				kind: 'drupal',
				state: 'suspended',
				accountId: 'acct_1',
				primaryHostname: 'www.example.edu'
			} as never);
			const fetch = answering(200, { captureStatements: true });
			await expect(choose('detailed')).resolves.toMatchObject({ applied: false });
			expect(fetch).not.toHaveBeenCalled();
		});

		it('leaves the choice unapplied when the access the dashboard holds is missing', async () => {
			vi.mocked(withOwnerToken).mockRejectedValueOnce(new ApiError('not_found', 'Not found'));
			await expect(choose('detailed')).resolves.toMatchObject({ applied: false });
		});
	});

	it('answers light for a site that never chose', async () => {
		await expect(
			getStrataStatus(moduleServices(), { orgId: ORG, siteId: SITE })
		).resolves.toEqual({
			allocation: 'light',
			capturesStatements: false,
			recoverySeconds: 900,
			applied: false,
			confirmedFreeAt: null,
			store: 'none',
			storeReason: null,
			storage: null
		});
	});

	it('reads the stored connection for a self-managed site and never for a managed one', async () => {
		vi.mocked(getReadySite).mockResolvedValue({
			id: SITE,
			kind: 'drupal',
			plane: 'self-managed',
			state: 'active',
			accountId: 'acct_1',
			primaryHostname: 'www.example.edu'
		} as never);
		await expect(
			getStrataStatus(moduleServices(), { orgId: ORG, siteId: SITE })
		).resolves.toMatchObject({ storage: 'needs_wider_token' });
		expect(selfManagedStorageCheck).toHaveBeenCalledWith(expect.anything(), ORG, 'acct_1');
		vi.mocked(selfManagedStorageCheck).mockClear();
		vi.mocked(getReadySite).mockResolvedValue({
			id: SITE,
			kind: 'drupal',
			plane: 'managed',
			state: 'active',
			accountId: 'acct_1',
			primaryHostname: 'www.example.edu'
		} as never);
		await expect(
			getStrataStatus(moduleServices(), { orgId: ORG, siteId: SITE })
		).resolves.toMatchObject({ storage: null });
		expect(selfManagedStorageCheck).not.toHaveBeenCalled();
	});
});

describe('Strata on a plan without it', () => {
	beforeEach(() => {
		const { features, ...rest } = entitlement('managed-pro');
		setModuleServices({
			...base,
			planOf: async () => ({ ...rest, features: { ...features, strata: false } })
		});
	});

	it('refuses the enable and the allocation', async () => {
		await expect(
			enableSiteModule(moduleServices(), { ...change, name: STRATA_MODULE, confirm: true })
		).rejects.toMatchObject({ details: { reason: 'feature_not_included' } });
		await expect(
			setStrataAllocation(moduleServices(), {
				orgId: ORG,
				siteId: SITE,
				allocation: 'light',
				actor: 'user:user-1'
			})
		).rejects.toMatchObject({ details: { reason: 'feature_not_included' } });
	});
});

describe('Strata routes', () => {
	const ROUTE = '/api/v1/orgs/:orgId/sites/:id/strata';
	const PATH = `/api/v1/orgs/${ORG}/sites/${ROUTE_SITE}/strata`;

	it('reads the status for a site', async () => {
		setup();
		plan = 'managed-pro';
		const res = await send(strataGet, ROUTE, { path: PATH, headers: asUser });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ allocation: 'light', recoverySeconds: 900 });
	});

	it('sets the allocation and refuses a value outside the list', async () => {
		setup();
		plan = 'managed-pro';
		const ok = await send(strataPut, ROUTE, {
			method: 'PUT',
			path: PATH,
			headers: asUser,
			json: { allocation: 'detailed' }
		});
		expect(ok.status).toBe(200);
		expect(ok.json).toMatchObject({ allocation: 'detailed', capturesStatements: true });
		const bad = await send(strataPut, ROUTE, {
			method: 'PUT',
			path: PATH,
			headers: asUser,
			json: { allocation: 'always' }
		});
		expect(bad.status).toBe(400);
	});
});
