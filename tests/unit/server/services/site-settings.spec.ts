import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDrupalDiscovery } from '../../../../src/server/integrations/site-discovery';
import {
	readSiteSettings,
	SETTINGS_CACHE_MS,
	type SiteSettingsServices,
	UNKNOWN_RELEASE_VERSION,
	UNKNOWN_SCHEMA_VERSION
} from '../../../../src/server/services/site-settings';
import { ApiError } from '../../../../src/shared/errors';
import type { Action } from '../../../../src/shared/permissions';
import { CONFIG_GROUPS } from '../../../../src/shared/permissions';
import { HOST, NOW, ok, ORG, SITE, world, type World } from './site-health-support';

const rows = vi.hoisted(() => ({
	site: null as Record<string, unknown> | null,
	discovery: null as null | {
		siteId: string;
		document: unknown;
		etag: string | null;
		fetchedAt: number;
	},
	upserts: 0,
	release: null as null | { version: string }
}));

vi.mock('../../../../src/server/db/repos/sites', () => ({
	getReadySite: async () => rows.site
}));
vi.mock('../../../../src/server/db/repos/releases', () => ({
	getRelease: async () => rows.release
}));
vi.mock('../../../../src/server/db/repos/site-discovery', () => ({
	getSiteDiscovery: async () => rows.discovery,
	upsertSiteDiscovery: async (_db: unknown, next: NonNullable<typeof rows.discovery>) => {
		rows.upserts += 1;
		rows.discovery = next;
	}
}));

const READ_ALL = CONFIG_GROUPS.map((g) => `site.config.${g}.read`) as Action[];

const LEVERS = [
	{
		name: 'WARM_INTERVAL_MS',
		value: '8000',
		source: 'default',
		domain: { kind: 'int', min: 8000, max: 600000, unit: 'ms', default: 8000 }
	},
	{ name: 'SPOOL', value: null, source: 'default', domain: { kind: 'flag' } },
	{ name: 'REDIRECTS', value: null, source: 'kv', domain: { kind: 'rules' } },
	{
		name: 'PLAN',
		value: 'paid',
		source: 'var',
		domain: { kind: 'enum', values: ['free', 'paid'] }
	}
];

const RELEASE = { version: 'rel_1', releaseId: 'rel_1', schemaVersion: 1 };

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

// a document as the dashboard composes it from the site's /settings answer
function composed() {
	return composeDrupalDiscovery({
		settings: { ok: true, levers: LEVERS } as never,
		release: RELEASE,
		siteId: SITE
	});
}

const answerLevers = (url: string) =>
	url.endsWith('/.well-known/drupflare')
		? new Response('', { status: 404 })
		: ok({ ok: true, levers: LEVERS });

const offline = () => {
	throw new TypeError('connect failed');
};

let w: World;

function call(permitted: readonly Action[] = READ_ALL) {
	const services: SiteSettingsServices = {
		...w.services,
		getDb: async () => ({}) as never,
		startOperation: async () => undefined,
		audit: async () => undefined
	};
	return readSiteSettings(services, {
		orgId: ORG,
		siteId: SITE,
		principal: { kind: 'user', userId: 'usr_1' },
		permitted
	});
}

const fieldsOf = (view: Awaited<ReturnType<typeof call>>) => view.groups.flatMap((g) => g.fields);

beforeEach(async () => {
	rows.site = siteRecord();
	rows.discovery = null;
	rows.upserts = 0;
	rows.release = null;
	w = await world(answerLevers);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('a live read', () => {
	it('reads the settings with the owner token and stores the document', async () => {
		const view = await call();

		expect(view).toMatchObject({ state: 'ready', source: 'live', stale: false });
		expect(view.redirects.length).toBeGreaterThan(0);
		expect(view.groups.map((g) => g.id)).toEqual([...CONFIG_GROUPS]);
		expect(w.fetched.at(-1)?.url).toBe(`https://${HOST}/settings`);
		expect(rows.upserts).toBe(1);
	});

	it('leaves out a group the principal cannot read', async () => {
		const view = await call(['site.config.runtime.read']);

		expect(view.groups.map((g) => g.id)).toEqual(['runtime']);
	});

	it('stores the registered release version and the site data schema', async () => {
		rows.release = { version: '2026.11.1' };
		rows.site = siteRecord({ dataSchemaVersion: 4 });
		await call();

		expect(rows.discovery?.document).toMatchObject({
			version: '2026.11.1',
			releaseId: 'rel_1',
			schemaVersion: 4
		});
	});

	it('marks an unregistered release and an unknown data schema with the sentinels', async () => {
		await call();

		expect(rows.discovery?.document).toMatchObject({
			version: UNKNOWN_RELEASE_VERSION,
			releaseId: 'rel_1',
			schemaVersion: UNKNOWN_SCHEMA_VERSION
		});
	});

	it('marks only the data schema unknown when the release is registered', async () => {
		rows.release = { version: '2026.11.1' };
		await call();

		expect(rows.discovery?.document).toMatchObject({
			version: '2026.11.1',
			schemaVersion: UNKNOWN_SCHEMA_VERSION
		});
	});

	it('shows the plan read-only with the platform reason', async () => {
		const plan = fieldsOf(await call()).find((f) => f.key === 'PLAN');

		expect(plan).toMatchObject({ editable: false, provenance: 'var' });
		expect(plan?.readOnlyReason).toContain('platform sets the plan');
	});

	it('shows an owner-only setting read-only with the owner reason', async () => {
		const spool = fieldsOf(await call()).find((f) => f.key === 'SPOOL');

		expect(spool?.editable).toBe(false);
		expect(spool?.readOnlyReason).toBe('Only the site owner can change this.');
	});
});

describe('a stored document', () => {
	it('is used inside the cache window without calling the site', async () => {
		rows.discovery = {
			siteId: SITE,
			document: composed(),
			etag: 'e',
			fetchedAt: NOW - SETTINGS_CACHE_MS / 2
		};
		const view = await call();

		expect(view).toMatchObject({ state: 'ready', source: 'stored', stale: false });
		expect(w.fetched).toEqual([]);
	});

	it('shows a widget the dashboard does not know as JSON', async () => {
		const doc = composed() as unknown as {
			settings: { schema: Record<string, { 'x-ui': Record<string, unknown> }> };
		};
		doc.settings.schema.WARM_INTERVAL_MS!['x-ui'].widget = 'sparkle';
		rows.discovery = { siteId: SITE, document: doc, etag: 'e', fetchedAt: NOW - 1000 };
		const warm = fieldsOf(await call()).find((f) => f.key === 'WARM_INTERVAL_MS');

		expect(warm?.widget).toBe('json');
	});

	it('is kept as the stale answer when the site stops answering', async () => {
		rows.discovery = {
			siteId: SITE,
			document: composed(),
			etag: 'e',
			fetchedAt: NOW - SETTINGS_CACHE_MS * 10
		};
		w = await world(offline);
		const view = await call();

		expect(view).toMatchObject({ state: 'ready', source: 'stored', stale: true });
		expect(view.observedAt).not.toBeNull();
	});
});

describe('when no source answers', () => {
	it('returns a plain empty state, not an error', async () => {
		w = await world(offline);
		const view = await call();

		expect(view.state).toBe('empty');
		expect(view.groups).toEqual([]);
		expect(view.reason).toEqual(expect.any(String));
	});

	it('returns the empty state for a site with no release on record', async () => {
		rows.site = siteRecord({ releaseId: null });
		const view = await call();

		expect(view.state).toBe('empty');
		expect(w.fetched).toEqual([]);
	});
});

describe('a site that is not Drupal', () => {
	it('is described from the registry without a call', async () => {
		rows.site = siteRecord({ kind: 'nuxtpress' });
		const view = await call();
		const warm = fieldsOf(view).find((f) => f.key === 'WARM_INTERVAL_MS');

		expect(view).toMatchObject({ state: 'fallback', source: 'registry' });
		expect(warm?.value).toBeNull();
		expect(w.fetched).toEqual([]);
	});
});

describe('a site that is not found', () => {
	it('is refused', async () => {
		rows.site = null;

		await expect(call()).rejects.toBeInstanceOf(ApiError);
	});
});
