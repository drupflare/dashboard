import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigChangeRecord } from '../../../../engine/src/ports';
import type { SiteSettingsServices } from '../../../../src/server/services/site-settings';
import {
	applySettings,
	listSettingsHistory,
	revertSettings,
	toSettingChangeView,
	type SettingsActor
} from '../../../../src/server/services/site-settings-write';
import type { Action } from '../../../../src/shared/permissions';
import { HOST, NOW, ok, ORG, SITE, world, type World } from './site-health-support';

const rows = vi.hoisted(() => ({
	site: null as Record<string, unknown> | null,
	earlier: null as unknown,
	created: true,
	operations: [] as Record<string, unknown>[],
	change: null as unknown,
	siblings: [] as unknown[],
	listed: [] as unknown[],
	keys: undefined as string[] | undefined
}));

vi.mock('../../../../src/server/db/repos/sites', () => ({
	getReadySite: async () => rows.site
}));
vi.mock('../../../../src/server/db/repos/releases', () => ({ getRelease: async () => null }));
vi.mock('../../../../src/server/db/repos/site-discovery', () => ({
	getSiteDiscovery: async () => null,
	upsertSiteDiscovery: async () => undefined
}));
vi.mock('../../../../src/server/db/repos/backups', () => ({
	createOperationRecord: async (_db: unknown, operation: Record<string, unknown>) => {
		rows.operations.push(operation);
		return {
			operation: { operation: { id: operation.id }, version: 0 },
			created: rows.created
		};
	}
}));
vi.mock('../../../../src/server/db/repos/operations', () => ({
	getOperationByKey: async () => rows.earlier,
	getOperation: async (_db: unknown, _org: string, id: string) => ({
		operation: { id },
		version: 0
	}),
	updateOperationStatus: async () => undefined
}));
vi.mock('../../../../src/server/db/repos/config-changes', () => ({
	getConfigChange: async () => rows.change,
	listOperationChanges: async () => rows.siblings,
	listConfigChanges: async (
		_db: unknown,
		_o: string,
		_s: string,
		options: { keys?: string[] }
	) => {
		rows.keys = options.keys;
		return rows.listed;
	}
}));

const LEVERS: Record<string, unknown>[] = [
	{
		name: 'WARM_INTERVAL_MS',
		value: null,
		source: 'default',
		domain: { kind: 'int', min: 8000, max: 600000, unit: 'ms', default: 8000 }
	},
	{ name: 'SPOOL', value: '1', source: 'kv', domain: { kind: 'flag' } },
	{
		name: 'CSP_MODE',
		value: null,
		source: 'default',
		domain: { kind: 'enum', values: ['off', 'report-only', 'enforce'] }
	},
	{
		name: 'REPLICA_AUTOSCALE',
		value: '0',
		source: 'var',
		domain: { kind: 'flag' }
	}
];

const WRITE_RUNTIME: Action[] = ['site.config.runtime.write'];
const WRITE_ALL = ['runtime', 'content', 'security', 'integrations', 'appearance', 'access'].map(
	(g) => `site.config.${g}.write`
) as Action[];

const actor = (over: Partial<SettingsActor> = {}): SettingsActor => ({
	principal: { kind: 'user', userId: 'usr_1' },
	permitted: WRITE_ALL,
	owner: true,
	...over
});

function siteRecord(over: Record<string, unknown> = {}) {
	return {
		id: SITE,
		organizationId: ORG,
		name: 'quiet-oak',
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: 'acct_1',
		state: 'active',
		primaryHostname: HOST,
		releaseId: 'rel_1',
		dataSchemaVersion: null,
		readyAt: NOW - 1000,
		createdAt: NOW - 2000,
		updatedAt: NOW - 2000,
		...over
	};
}

let w: World;
let started: { workflow: string; id: string; params: Record<string, unknown> }[];
let audits: { action: string; detail?: Record<string, unknown> }[];

const answer = (url: string) =>
	url.endsWith('/.well-known/drupflare')
		? new Response('', { status: 404 })
		: ok({ ok: true, levers: LEVERS });

function services(): SiteSettingsServices {
	return {
		...w.services,
		getDb: async () => ({}) as never,
		startOperation: async (request) => {
			started.push(request as never);
		},
		audit: async (_org, input) => {
			audits.push(input);
		}
	};
}

// the etag the site reports now, read the way the page reads it
async function currentEtag(): Promise<string> {
	let etag = '';
	await applySettings(services(), {
		orgId: ORG,
		siteId: SITE,
		actor: actor(),
		changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }],
		etag: 'stale',
		idempotencyKey: 'probe'
	}).catch((error: { details?: { etag?: string } }) => {
		etag = error.details?.etag ?? '';
	});
	started.length = 0;
	rows.operations.length = 0;
	return etag;
}

const apply = async (over: Partial<Parameters<typeof applySettings>[1]> = {}, etag?: string) =>
	applySettings(services(), {
		orgId: ORG,
		siteId: SITE,
		actor: actor(),
		changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }],
		etag: etag ?? (await currentEtag()),
		idempotencyKey: 'key-1',
		...over
	});

beforeEach(async () => {
	rows.site = siteRecord();
	rows.earlier = null;
	rows.created = true;
	rows.operations = [];
	rows.change = null;
	rows.siblings = [];
	rows.listed = [];
	started = [];
	audits = [];
	w = await world(answer);
});

describe('applySettings', () => {
	it('starts the operation with the values the site held, and audits the keys only', async () => {
		await apply();

		expect(started).toHaveLength(1);
		const [request] = started;
		expect(request?.workflow).toBe('config-apply');
		expect(request?.params).toMatchObject({
			orgId: ORG,
			siteId: SITE,
			actor: 'user:usr_1',
			owner: true,
			changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }],
			expected: { WARM_INTERVAL_MS: null }
		});
		expect(rows.operations[0]?.type).toBe('config.apply');
		expect(audits).toEqual([
			{
				actor: 'user:usr_1',
				action: 'site.config.write',
				target: SITE,
				detail: { operationId: request?.id, keys: ['WARM_INTERVAL_MS'] }
			}
		]);
	});

	it('answers a conflict with the current values and the new etag, and starts nothing', async () => {
		const error = await apply({}, 'an-old-etag').catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: 'conflict',
			status: 409,
			details: { reason: 'settings_changed', current: { WARM_INTERVAL_MS: null } }
		});
		expect((error as { details: { etag: string } }).details.etag).toMatch(/^"[0-9a-f]{32}"$/);
		expect(started).toEqual([]);
		expect(rows.operations).toEqual([]);
	});

	it('refuses a group the caller cannot write before it reads the site', async () => {
		const error = await apply(
			{
				actor: actor({ permitted: WRITE_RUNTIME, owner: true }),
				changes: [{ key: 'SPOOL', value: '0' }]
			},
			'x'
		).catch((e: unknown) => e);

		expect(error).toMatchObject({
			status: 403,
			details: { reason: 'group_not_writable', group: 'security', key: 'SPOOL' }
		});
		expect(started).toEqual([]);
	});

	it.each([
		['PLAN', 'plan_not_writable', true],
		['REPLICA_AUTOSCALE', 'not_overridable', true],
		['CSP_MODE', 'owner_only', false]
	])('refuses %s with %s and starts nothing', async (key, reason, owner) => {
		const error = await apply(
			{ actor: actor({ owner }), changes: [{ key, value: 'enforce' }] },
			'x'
		).catch((e: unknown) => e);

		expect(error).toMatchObject({ status: 422, details: { reason, key } });
		expect(started).toEqual([]);
	});

	it('refuses a value the site schema rejects, naming the key', async () => {
		const error = await apply({ changes: [{ key: 'WARM_INTERVAL_MS', value: 5 }] }).catch(
			(e: unknown) => e
		);

		expect(error).toMatchObject({ status: 422, details: { reason: 'setting_invalid' } });
		expect((error as { details: { errors: { key: string }[] } }).details.errors[0]?.key).toBe(
			'WARM_INTERVAL_MS'
		);
		expect(started).toEqual([]);
	});

	it('refuses the same key twice', async () => {
		const error = await apply(
			{
				changes: [
					{ key: 'WARM_INTERVAL_MS', value: 9000 },
					{ key: 'WARM_INTERVAL_MS', value: 10000 }
				]
			},
			'x'
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'validation' });
	});

	it('answers a repeat with the first operation and reads nothing', async () => {
		rows.earlier = { operation: { id: 'op_first' }, version: 0 };
		const before = w.fetched.length;

		const result = await apply({}, 'x');

		expect(result).toMatchObject({ operation: { id: 'op_first' } });
		expect(w.fetched.length).toBe(before);
		expect(started).toEqual([]);
	});

	it('returns an operation that already exists without starting it again', async () => {
		rows.created = false;
		await apply();
		expect(started).toEqual([]);
		expect(audits).toEqual([]);
	});

	it('says so when the site does not answer', async () => {
		w = await world(() => {
			throw new TypeError('connect failed');
		});
		const error = await apply({}, 'x').catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 422, details: { reason: 'site_unreachable' } });
	});

	it('finds nothing for a site that is not ready, and refuses one that is not Drupal or not active', async () => {
		rows.site = null;
		await expect(apply({}, 'x')).rejects.toMatchObject({ status: 404 });
		rows.site = siteRecord({ kind: 'node' });
		await expect(apply({}, 'x')).rejects.toMatchObject({
			details: { reason: 'not_writable_here' }
		});
		rows.site = siteRecord({ state: 'suspended' });
		await expect(apply({}, 'x')).rejects.toMatchObject({
			details: { reason: 'site_not_active' }
		});
	});

	it('closes the operation as failed when the engine refuses the start', async () => {
		const failing = {
			...services(),
			startOperation: async () => {
				throw new Error('engine down');
			}
		};
		const etag = await currentEtag();
		await expect(
			applySettings(failing, {
				orgId: ORG,
				siteId: SITE,
				actor: actor(),
				changes: [{ key: 'WARM_INTERVAL_MS', value: 30000 }],
				etag,
				idempotencyKey: 'key-2'
			})
		).rejects.toMatchObject({ details: { operationId: expect.any(String) } });
	});
});

const record = (over: Partial<ConfigChangeRecord> = {}): ConfigChangeRecord => ({
	id: 'cfg_op_1_WARM_INTERVAL_MS',
	organizationId: ORG,
	siteId: SITE,
	operationId: 'op_1',
	key: 'WARM_INTERVAL_MS',
	before: JSON.stringify({ value: 20000, source: 'kv' }),
	after: '30000',
	actor: 'user:usr_1',
	status: 'applied',
	createdAt: NOW,
	revertedBy: null,
	...over
});

describe('a secret setting', () => {
	async function withSecret(run: () => Promise<void>) {
		const { SITE_CONFIG_REGISTRY, KV_OVERRIDABLE_NAMES } =
			await import('../../../../src/shared/site-config/registry');
		const names = KV_OVERRIDABLE_NAMES as unknown as string[];
		SITE_CONFIG_REGISTRY['SECRET_X'] = {
			label: 'Secret',
			layer: 'kv',
			permission: 'runtime',
			domain: { kind: 'text' },
			widget: 'secret'
		};
		names.push('SECRET_X');
		LEVERS.push({
			name: 'SECRET_X',
			value: 'live-plaintext',
			source: 'kv',
			domain: { kind: 'enum', values: ['live-plaintext', 'typed-plaintext'] }
		});
		try {
			await run();
		} finally {
			delete SITE_CONFIG_REGISTRY['SECRET_X'];
			names.splice(names.indexOf('SECRET_X'), 1);
			LEVERS.pop();
		}
	}

	it('answers a conflict with Set and never the value', async () => {
		await withSecret(async () => {
			const error = await apply(
				{ changes: [{ key: 'SECRET_X', value: 'typed-plaintext' }] },
				'an-old-etag'
			).catch((e: unknown) => e);

			expect(error).toMatchObject({
				code: 'conflict',
				details: { current: { SECRET_X: 'Set' } }
			});
			const body = JSON.stringify((error as { details: unknown }).details);
			expect(body).not.toContain('live-plaintext');
			expect(body).not.toContain('typed-plaintext');
		});
	});

	it('never echoes a refused secret value in the validation errors', async () => {
		await withSecret(async () => {
			const error = await apply({
				changes: [{ key: 'SECRET_X', value: 'rejected-plaintext' }]
			}).catch((e: unknown) => e);

			expect(error).toMatchObject({
				details: {
					reason: 'setting_invalid',
					errors: [{ key: 'SECRET_X', message: 'This value is not valid.' }]
				}
			});
			expect(JSON.stringify(error)).not.toContain('rejected-plaintext');
			expect(JSON.stringify(error)).not.toContain('live-plaintext');
		});
	});

	it('stores a digest on the operation and sends the engine the value it needs', async () => {
		await withSecret(async () => {
			await apply({ changes: [{ key: 'SECRET_X', value: 'typed-plaintext' }] });

			const stored = JSON.stringify(rows.operations);
			expect(stored).not.toContain('live-plaintext');
			expect(stored).not.toContain('typed-plaintext');
			expect(stored).toMatch(/[0-9a-f]{64}/);
			const [request] = started;
			expect(JSON.stringify(request?.params)).toContain('typed-plaintext');
			expect(JSON.stringify(request?.params)).not.toContain('live-plaintext');
			expect(JSON.stringify(audits)).not.toContain('plaintext');
		});
	});

	it('refuses a revert that would write a secret back', async () => {
		await withSecret(async () => {
			const row = record({
				key: 'SECRET_X',
				before: JSON.stringify({ value: 'Set', source: 'kv' })
			});
			rows.change = row;
			rows.siblings = [row];
			await expect(
				revertSettings(services(), {
					orgId: ORG,
					siteId: SITE,
					changeId: row.id,
					actor: actor(),
					idempotencyKey: 'rev-2'
				})
			).rejects.toMatchObject({ details: { reason: 'secret_not_revertable' } });
			expect(started).toEqual([]);
		});
	});
});

describe('revertSettings', () => {
	const revert = (over: Partial<SettingsActor> = {}) =>
		revertSettings(services(), {
			orgId: ORG,
			siteId: SITE,
			changeId: 'cfg_op_1_WARM_INTERVAL_MS',
			actor: actor(over),
			idempotencyKey: 'rev-1'
		});

	it('writes the before values of every change of that apply and names the rows it undoes', async () => {
		const other = record({
			id: 'cfg_op_1_SPOOL',
			key: 'SPOOL',
			before: JSON.stringify({ value: '1', source: 'var' }),
			after: '"0"'
		});
		rows.change = record();
		rows.siblings = [record(), other, record({ id: 'done', revertedBy: 'op_2' })];

		await revert();

		const [request] = started;
		expect(request?.workflow).toBe('config-apply');
		expect(request?.params).toMatchObject({
			changes: [
				{ key: 'WARM_INTERVAL_MS', value: 20000 },
				{ key: 'SPOOL', value: null }
			],
			reverts: ['cfg_op_1_WARM_INTERVAL_MS', 'cfg_op_1_SPOOL']
		});
		expect(audits[0]?.action).toBe('site.config.revert');
	});

	it('finds nothing for a change that is not on the site', async () => {
		rows.change = null;
		await expect(revert()).rejects.toMatchObject({ status: 404 });
	});

	it('answers 409 for a change that was already reverted', async () => {
		rows.change = record({ revertedBy: 'op_2' });
		await expect(revert()).rejects.toMatchObject({
			status: 409,
			details: { reason: 'already_reverted' }
		});
	});

	it('refuses a change that never reached the site', async () => {
		rows.change = record({ status: 'failed' });
		await expect(revert()).rejects.toMatchObject({ details: { reason: 'not_revertable' } });
	});

	it('needs the same write permission as the original change', async () => {
		rows.change = record({
			key: 'SPOOL',
			before: JSON.stringify({ value: '1', source: 'kv' })
		});
		rows.siblings = [rows.change as ConfigChangeRecord];
		await expect(revert({ permitted: WRITE_RUNTIME })).rejects.toMatchObject({
			details: { reason: 'group_not_writable' }
		});
		expect(started).toEqual([]);
	});
});

describe('settings history', () => {
	it('lists for a ready site and finds nothing for another', async () => {
		rows.listed = [record()];
		const readRuntime: Action[] = ['site.config.runtime.read'];
		const input = { orgId: ORG, siteId: SITE, count: 5, permitted: readRuntime };
		expect(await listSettingsHistory(services(), input)).toEqual([record()]);
		expect(rows.keys).toContain('WARM_INTERVAL_MS');
		expect(rows.keys).not.toContain('SPOOL');
		await listSettingsHistory(services(), { ...input, permitted: [] });
		expect(rows.keys).toEqual([]);
		rows.site = null;
		await expect(listSettingsHistory(services(), input)).rejects.toMatchObject({ status: 404 });
	});

	it('shows a secret only as set or not set', async () => {
		const { SITE_CONFIG_REGISTRY } =
			await import('../../../../src/shared/site-config/registry');
		SITE_CONFIG_REGISTRY['SECRET_X'] = {
			label: 'Secret',
			layer: 'kv',
			permission: 'runtime',
			domain: { kind: 'text' },
			widget: 'secret'
		};
		try {
			const view = toSettingChangeView(
				record({
					key: 'SECRET_X',
					before: JSON.stringify({ value: null, source: 'default' }),
					after: '"hunter2"'
				}),
				String
			);
			expect(view).toMatchObject({ before: 'Not Set', after: 'Set' });
			expect(JSON.stringify(view)).not.toContain('hunter2');
		} finally {
			delete SITE_CONFIG_REGISTRY['SECRET_X'];
		}
	});

	it('shows the value before, the value after and whether a row can be reverted', () => {
		const view = toSettingChangeView(record(), (key) => `Label of ${key}`);
		expect(view).toMatchObject({
			label: 'Label of WARM_INTERVAL_MS',
			before: 20000,
			after: 30000,
			status: 'applied',
			reverted: false,
			revertable: true
		});
		expect(toSettingChangeView(record({ revertedBy: 'op_2' }), String)).toMatchObject({
			reverted: true,
			revertable: false
		});
		expect(toSettingChangeView(record({ status: 'unverified' }), String).revertable).toBe(true);
		expect(toSettingChangeView(record({ status: 'failed' }), String).revertable).toBe(false);
	});
});
