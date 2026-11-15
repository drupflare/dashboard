import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import siteSettings from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/settings.get';
import settingsPut from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/settings.put';
import history from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/settings/history.get';
import revert from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/settings/history/[changeId]/revert.post';
import {
	resetSiteSettingsServices,
	setSiteSettingsServices
} from '../../../../src/server/services/site-settings';
import { resetApiDeps, type LoadInput } from '../../../../src/server/utils/define-api';
import { SITE_CONFIG_REGISTRY } from '../../../../src/shared/site-config/registry';
import { settingsViewSchema } from '../../../../src/shared/site-config/view';
import { DEPT, facts, fresh, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { ORG, SITE, ok, siteRow, world } from '../services/site-health-support';

vi.mock('../../../../src/server/db/repos/site-discovery', () => ({
	getSiteDiscovery: async () => null,
	upsertSiteDiscovery: async () => undefined
}));
// the fixture db answers every query with the site row, so the release lookup must not reach it
vi.mock('../../../../src/server/db/repos/releases', () => ({
	getRelease: async () => null
}));

const rows = vi.hoisted(() => ({
	started: [] as { workflow: string; params: Record<string, unknown> }[],
	change: null as unknown,
	listed: [] as { id: string; key: string; [field: string]: unknown }[],
	keys: undefined as readonly string[] | undefined
}));
vi.mock('../../../../src/server/db/repos/backups', () => ({
	createOperationRecord: async (_db: unknown, operation: { id: string }) => ({
		operation: { operation: { id: operation.id }, version: 0 },
		created: true
	})
}));
vi.mock('../../../../src/server/db/repos/operations', () => ({
	getOperationByKey: async () => null,
	getOperation: async (_db: unknown, _org: string, id: string) => ({
		operation: {
			id,
			orgId: 'org_x',
			type: 'config.apply',
			status: 'planned',
			idempotencyKey: 'k',
			targetIds: [],
			preconditions: [],
			planDigest: `sha256:${'0'.repeat(64)}`,
			fencingEpoch: 0,
			blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
			rollbackPoint: null,
			cursor: null,
			steps: [],
			verification: 'pending',
			finalObservation: null,
			budget: {
				maxDestructiveSites: 5,
				maxConcurrentProductionDeploys: 10,
				elevated: false,
				bulkDeleteConfirmation: null
			},
			createdAt: '2026-11-07T12:00:00.000Z',
			updatedAt: '2026-11-07T12:00:00.000Z'
		},
		version: 0
	}),
	updateOperationStatus: async () => undefined
}));
vi.mock('../../../../src/server/db/repos/config-changes', () => ({
	getConfigChange: async () => rows.change,
	listOperationChanges: async () => (rows.change === null ? [] : [rows.change]),
	listConfigChanges: async (
		_db: unknown,
		_org: string,
		_site: string,
		options: { keys?: readonly string[] }
	) => {
		rows.keys = options.keys;
		return rows.listed.filter((row) => options.keys?.includes(row.key) ?? true);
	}
}));

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/settings';
const path = (orgId = ORG, id = SITE) => `/api/v1/orgs/${orgId}/sites/${id}/settings`;
const STRANGER = 'site_bbbbbbbb';

const LEVERS = [{ name: 'SPOOL', value: null, source: 'default', domain: { kind: 'flag' } }];

const answer = (url: string) =>
	url.endsWith('/.well-known/drupflare')
		? new Response('', { status: 404 })
		: ok({ ok: true, levers: LEVERS });

// the loader answers for the site in the path, and for nothing outside the caller's organisation
function load(options: { role?: 'viewer' | 'owner' | null } = {}) {
	return async (input: LoadInput) => {
		if (input.params.id === STRANGER) return null;
		const role = options.role === undefined ? 'owner' : options.role;
		const base = role === null ? facts({ ...fresh }) : facts({ ...member(role), ...fresh });
		return {
			resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
			facts: base
		};
	};
}

beforeEach(async () => {
	const w = await world(answer, { db: { site: siteRow({ release_id: 'rel_1' }) } });
	rows.started = [];
	rows.change = null;
	rows.listed = [];
	setSiteSettingsServices({
		...w.services,
		startOperation: async (request) => {
			rows.started.push(request as never);
		},
		audit: async () => undefined
	});
});

afterEach(() => {
	resetSiteSettingsServices();
	resetApiDeps();
});

describe('GET /api/v1/orgs/{orgId}/sites/{id}/settings', () => {
	it('returns the settings of the site, matching its declared response', async () => {
		const { errors } = setup({ deps: { load: load() } });
		const reply = await send(siteSettings, ROUTE, { path: path(), headers: asUser });

		expect(errors).toEqual([]);
		expect(reply.status).toBe(200);
		expect(settingsViewSchema.parse(reply.json)).toMatchObject({
			state: 'ready',
			source: 'live'
		});
	});

	it('refuses a person with no relationship to the organisation', async () => {
		setup({ deps: { load: load({ role: null }) } });
		const reply = await send(siteSettings, ROUTE, { path: path(), headers: asUser });

		expect(reply.status).toBe(403);
	});

	it('finds nothing for a site of another organisation', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(siteSettings, ROUTE, {
			path: path(ORG, STRANGER),
			headers: asUser
		});

		expect(reply.status).toBe(404);
	});

	it('refuses a key without site.config.runtime.read', async () => {
		const { denials } = setup({ deps: { load: load() } });
		const reply = await send(siteSettings, ROUTE, { path: path(), headers: asKey });

		expect(reply.status).toBe(403);
		expect(denials).toHaveLength(1);
	});
});

const WRITE_ROUTE = '/api/v1/orgs/:orgId/sites/:id/settings';
const idem = { ...asUser, 'idempotency-key': 'key-settings-1' };

async function etagNow(): Promise<string> {
	setup({ deps: { load: load() } });
	const reply = await send(siteSettings, ROUTE, { path: path(), headers: asUser });
	return (reply.json as { etag: string }).etag;
}

describe('GET settings', () => {
	it('carries the etag and lets an owner edit an owner-only setting', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(siteSettings, ROUTE, { path: path(), headers: asUser });
		const view = settingsViewSchema.parse(reply.json);
		expect(view.etag).toMatch(/^"[0-9a-f]{32}"$/);
		const spool = view.groups.flatMap((g) => g.fields).find((f) => f.key === 'SPOOL');
		expect(spool).toMatchObject({ editable: true, readOnlyReason: null });
	});

	it('keeps an owner-only setting read-only for a developer', async () => {
		setup({ deps: { load: load({ role: 'developer' as never }) } });
		const reply = await send(siteSettings, ROUTE, { path: path(), headers: asUser });
		const view = settingsViewSchema.parse(reply.json);
		const spool = view.groups.flatMap((g) => g.fields).find((f) => f.key === 'SPOOL');
		expect(spool?.editable).toBe(false);
	});
});

describe('PUT settings', () => {
	it('starts the change and answers 202 with its operation', async () => {
		const etag = await etagNow();
		const { errors } = setup({ deps: { load: load() } });
		const reply = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: idem,
			json: { etag, changes: [{ key: 'SPOOL', value: '0' }] }
		});

		expect(errors).toEqual([]);
		expect(reply.status).toBe(202);
		expect(rows.started[0]).toMatchObject({
			workflow: 'config-apply',
			params: { changes: [{ key: 'SPOOL', value: '0' }], owner: true }
		});
	});

	it('answers 409 with the current values when the etag is old', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: idem,
			json: { etag: 'old', changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { current: { SPOOL: null } } });
		expect(rows.started).toEqual([]);
	});

	it('needs an Idempotency-Key and at least one change', async () => {
		setup({ deps: { load: load() } });
		const missing = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: asUser,
			json: { etag: 'x', changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(missing.status).toBe(400);
		const empty = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: idem,
			json: { etag: 'x', changes: [] }
		});
		expect(empty.status).toBe(400);
	});

	it('refuses a viewer, and a developer for an owner-only setting', async () => {
		const etag = await etagNow();
		setup({ deps: { load: load({ role: 'viewer' }) } });
		const viewer = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: idem,
			json: { etag, changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(viewer.status).toBe(403);

		setup({ deps: { load: load({ role: 'developer' as never }) } });
		const developer = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(),
			headers: idem,
			json: { etag, changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(developer.status).toBe(422);
		expect(developer.json).toMatchObject({ details: { reason: 'owner_only', key: 'SPOOL' } });
		expect(rows.started).toEqual([]);
	});

	it('finds nothing for a site of another organisation', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(settingsPut, WRITE_ROUTE, {
			method: 'PUT',
			path: path(ORG, STRANGER),
			headers: idem,
			json: { etag: 'x', changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(reply.status).toBe(404);
	});
});

describe('GET settings history', () => {
	it('lists the changes with their labels', async () => {
		rows.listed = [
			{
				id: 'cfg_op_1_SPOOL',
				organizationId: ORG,
				siteId: SITE,
				operationId: 'op_1',
				key: 'SPOOL',
				before: JSON.stringify({ value: '1', source: 'kv' }),
				after: '"0"',
				actor: 'user:u',
				status: 'applied',
				createdAt: 1_790_000_000_000,
				revertedBy: null
			}
		];
		setup({ deps: { load: load() } });
		const reply = await send(history, `${ROUTE}/history`, {
			path: `${path()}/history`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			items: [{ key: 'SPOOL', label: 'Spool', before: '1', after: '0', revertable: true }],
			nextCursor: null
		});
	});

	const changeRow = (key: string, over: Record<string, unknown> = {}) => ({
		id: `cfg_op_1_${key}`,
		organizationId: ORG,
		siteId: SITE,
		operationId: 'op_1',
		key,
		before: JSON.stringify({ value: '1', source: 'kv' }),
		after: '"0"',
		actor: 'user:u',
		status: 'applied',
		createdAt: 1_790_000_000_000,
		revertedBy: null,
		...over
	});
	const listAs = (role: 'viewer' | 'owner') => {
		setup({ deps: { load: load({ role }) } });
		return send(history, `${ROUTE}/history`, { path: `${path()}/history`, headers: asUser });
	};

	it('leaves out a change to a group the caller cannot read', async () => {
		rows.listed = [changeRow('SPOOL'), changeRow('WARM_INTERVAL_MS')];
		const viewer = await listAs('viewer');
		expect(viewer.status).toBe(200);
		expect((viewer.json as { items: { key: string }[] }).items.map((i) => i.key)).toEqual([
			'WARM_INTERVAL_MS'
		]);
		expect(rows.keys).not.toContain('SPOOL');
		const owner = await listAs('owner');
		expect((owner.json as { items: { key: string }[] }).items.map((i) => i.key)).toEqual([
			'SPOOL',
			'WARM_INTERVAL_MS'
		]);
	});

	it('never puts the value of a secret in the response', async () => {
		SITE_CONFIG_REGISTRY['SECRET_X'] = {
			label: 'Secret',
			layer: 'kv',
			permission: 'runtime',
			domain: { kind: 'text' },
			widget: 'secret'
		};
		try {
			rows.listed = [
				changeRow('SECRET_X', {
					before: JSON.stringify({ value: 'hunter2-old', source: 'kv' }),
					after: '"hunter2-new"'
				})
			];
			const reply = await listAs('owner');
			expect(reply.text).not.toContain('hunter2');
			expect(reply.json).toMatchObject({
				items: [{ key: 'SECRET_X', before: 'Set', after: 'Set' }]
			});
		} finally {
			delete SITE_CONFIG_REGISTRY['SECRET_X'];
		}
	});

	it('finds nothing for a site of another organisation', async () => {
		setup({ deps: { load: load() } });
		const reply = await send(history, `${ROUTE}/history`, {
			path: `${path(ORG, STRANGER)}/history`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('POST settings history revert', () => {
	const revertPath = (changeId = 'cfg_op_1_SPOOL') => `${path()}/history/${changeId}/revert`;
	const REVERT_ROUTE = `${ROUTE}/history/:changeId/revert`;

	it('starts a change that puts the before value back', async () => {
		rows.change = {
			id: 'cfg_op_1_SPOOL',
			organizationId: ORG,
			siteId: SITE,
			operationId: 'op_1',
			key: 'SPOOL',
			before: JSON.stringify({ value: '1', source: 'kv' }),
			after: '"0"',
			actor: 'user:u',
			status: 'applied',
			createdAt: 1_790_000_000_000,
			revertedBy: null
		};
		setup({ deps: { load: load() } });
		const reply = await send(revert, REVERT_ROUTE, {
			method: 'POST',
			path: revertPath(),
			headers: idem
		});
		expect(reply.status).toBe(202);
		expect(rows.started[0]?.params).toMatchObject({
			changes: [{ key: 'SPOOL', value: '1' }],
			reverts: ['cfg_op_1_SPOOL']
		});
	});

	it('answers 404 for a change that does not exist and needs an Idempotency-Key', async () => {
		setup({ deps: { load: load() } });
		const missing = await send(revert, REVERT_ROUTE, {
			method: 'POST',
			path: revertPath('nope'),
			headers: idem
		});
		expect(missing.status).toBe(404);
		const unkeyed = await send(revert, REVERT_ROUTE, {
			method: 'POST',
			path: revertPath(),
			headers: asUser
		});
		expect(unkeyed.status).toBe(400);
	});

	it('refuses a revert of a group the caller cannot write', async () => {
		rows.change = {
			id: 'cfg_op_1_SPOOL',
			organizationId: ORG,
			siteId: SITE,
			operationId: 'op_1',
			key: 'SPOOL',
			before: JSON.stringify({ value: '1', source: 'kv' }),
			after: '"0"',
			actor: 'user:u',
			status: 'applied',
			createdAt: 1_790_000_000_000,
			revertedBy: null
		};
		setup({ deps: { load: load({ role: 'developer' as never }) } });
		const reply = await send(revert, REVERT_ROUTE, {
			method: 'POST',
			path: revertPath(),
			headers: idem
		});
		expect(reply.status).toBeGreaterThanOrEqual(400);
		expect(rows.started).toEqual([]);
	});

	it('refuses a viewer', async () => {
		setup({ deps: { load: load({ role: 'viewer' }) } });
		const reply = await send(revert, REVERT_ROUTE, {
			method: 'POST',
			path: revertPath(),
			headers: idem
		});
		expect(reply.status).toBe(403);
	});
});
