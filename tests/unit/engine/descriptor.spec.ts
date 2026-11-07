import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import type { SiteConfig } from '../../../contracts/src/sites';
import {
	DESCRIPTOR_ERROR_CODES,
	DescriptorError,
	buildDescriptor,
	redact,
	type DescriptorInput,
	type RecipeBindings,
	type SiteResourceRef
} from '../../../engine/src/descriptor';
import { planResources } from '../../../engine/src/provision-plan';

type Json = Record<string, unknown>;

const FIXTURES: Record<SiteConfig, string> = {
	managed: 'wrangler.managed.jsonc',
	canonical: 'wrangler.jsonc'
};

function fixture(config: SiteConfig): Json {
	const url = new URL(`./fixtures/${FIXTURES[config]}`, import.meta.url);
	return JSON.parse(readFileSync(url, 'utf8')) as Json;
}

const HANDLED = new Set([
	'compatibility_date',
	'compatibility_flags',
	'vars',
	'rules',
	'durable_objects',
	'kv_namespaces',
	'd1_databases',
	'r2_buckets',
	'send_email',
	'version_metadata',
	'migrations',
	'assets',
	'triggers',
	'observability'
]);
// resolved when the bundle is built, or by the script name
const BUNDLE = new Set(['$schema', 'name', 'main', 'minify', 'build', 'alias']);

function makeSite() {
	return {
		id: newId('site'),
		orgId: newId('org'),
		kind: 'drupal' as const,
		plane: 'managed' as const,
		ring: 'R2' as const,
		plan: 'managed-free'
	};
}

function refs(siteId: string, config: SiteConfig, database: boolean): SiteResourceRef[] {
	return planResources({ id: siteId }, config, { database }).create.map((item) => ({
		siteId,
		kind: item.kind,
		binding: item.binding,
		providerId: `id-${siteId}-${item.binding}`
	}));
}

function input(config: SiteConfig, database = true, patch: Partial<DescriptorInput> = {}) {
	const site = makeSite();
	return {
		config,
		site,
		resources: refs(site.id, config, database),
		secrets: {},
		release: { id: '1.0.4' },
		...patch
	} satisfies DescriptorInput;
}

// what the config file states, with no per-site value
function expected(config: SiteConfig): Json {
	const file = fixture(config);
	const bindings: Json = {};
	const put = (name: string, value: Json) => void (bindings[name] = { name, ...value });
	for (const [name, text] of Object.entries(file.vars as Json)) {
		put(name, { type: 'plain_text', text });
	}
	const objects = (file.durable_objects as { bindings: Json[] }).bindings;
	for (const item of objects) {
		put(item.name as string, { type: 'durable_object_namespace', class_name: item.class_name });
	}
	for (const item of (file.kv_namespaces ?? []) as Json[]) {
		put(item.binding as string, { type: 'kv_namespace' });
	}
	for (const item of (file.d1_databases ?? []) as Json[]) {
		put(item.binding as string, { type: 'd1' });
	}
	for (const item of (file.r2_buckets ?? []) as Json[]) {
		put(item.binding as string, { type: 'r2_bucket' });
	}
	for (const item of (file.send_email ?? []) as Json[]) {
		put(item.name as string, { type: 'send_email' });
	}
	put((file.version_metadata as Json).binding as string, { type: 'version_metadata' });
	put((file.assets as Json).binding as string, { type: 'assets' });
	return {
		bindings,
		compatibility_date: file.compatibility_date,
		compatibility_flags: file.compatibility_flags,
		migrations: file.migrations,
		observability: file.observability,
		rules: file.rules,
		crons: (file.triggers as { crons: string[] }).crons
	};
}

function actual(config: SiteConfig, database = true): Json {
	const built = buildDescriptor(input(config, database));
	const bindings: Json = {};
	for (const binding of built.metadata.bindings ?? []) bindings[binding.name] = binding;
	return {
		bindings,
		compatibility_date: built.metadata.compatibility_date,
		compatibility_flags: built.metadata.compatibility_flags,
		migrations: built.metadata.migrations,
		observability: built.metadata.observability,
		rules: built.rules,
		crons: built.crons
	};
}

function flatten(value: unknown, path = ''): Map<string, unknown> {
	const out = new Map<string, unknown>();
	if (value !== null && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) {
			for (const [p, v] of flatten(child, path ? `${path}.${key}` : key)) out.set(p, v);
		}
	} else out.set(path, value);
	return out;
}

function differing(a: Json, b: Json): string[] {
	const left = flatten(a);
	const right = flatten(b);
	const keys = new Set([...left.keys(), ...right.keys()]);
	return [...keys].filter((key) => left.get(key) !== right.get(key)).sort();
}

const ALLOWED: Record<SiteConfig, string[]> = {
	managed: [
		'bindings.CONFIG_KV.namespace_id',
		'bindings.FILES.bucket_name',
		'bindings.FILES_PRIVATE.bucket_name',
		'bindings.FLEET_DB.id',
		'bindings.PAGE_KV.namespace_id',
		'bindings.PLAN.text',
		'bindings.SITE_ID.name',
		'bindings.SITE_ID.text',
		'bindings.SITE_ID.type'
	],
	canonical: [
		'bindings.CONFIG_KV.namespace_id',
		'bindings.FLEET_DB.id',
		'bindings.PAGE_KV.namespace_id',
		'bindings.PLAN.text',
		'bindings.SITE_ID.name',
		'bindings.SITE_ID.text',
		'bindings.SITE_ID.type'
	]
};

describe('the descriptor against the Worker configs', () => {
	for (const config of ['managed', 'canonical'] as const) {
		it(`covers every key of the ${config} config`, () => {
			for (const key of Object.keys(fixture(config))) {
				expect(HANDLED.has(key) || BUNDLE.has(key), `${config}: ${key}`).toBe(true);
			}
		});

		it(`differs from the ${config} config only in per-site ids, PLAN and SITE_ID`, () => {
			expect(differing(expected(config), actual(config))).toEqual(ALLOWED[config]);
		});
	}

	it('binds R2 and the email binding on the managed config and neither on the canonical one', () => {
		const types = (config: SiteConfig) =>
			(buildDescriptor(input(config)).metadata.bindings ?? []).map((b) => b.type);
		expect(types('managed')).toEqual(expect.arrayContaining(['r2_bucket', 'send_email']));
		expect(types('canonical')).not.toContain('r2_bucket');
		expect(types('canonical')).not.toContain('send_email');
	});

	it('leaves the database out unless a resource for it is given', () => {
		const names = (database: boolean) =>
			(buildDescriptor(input('managed', database)).metadata.bindings ?? []).map(
				(b) => b.name
			);
		expect(names(false)).not.toContain('FLEET_DB');
		expect(names(true)).toContain('FLEET_DB');
	});

	it('never carries a resource id from another site', () => {
		const a = input('managed');
		const b = input('managed');
		const text = JSON.stringify(buildDescriptor(a));
		for (const ref of b.resources) expect(text).not.toContain(ref.providerId);
		for (const ref of a.resources) expect(text).toContain(ref.providerId);
	});

	it('sets PLAN and SITE_ID per site and tags the script', () => {
		const built = buildDescriptor(input('managed'));
		const plain = Object.fromEntries(
			(built.metadata.bindings ?? [])
				.filter((b) => b.type === 'plain_text')
				.map((b) => [b.name, (b as { text: string }).text])
		);
		expect(plain.PLAN).toBe('managed-free');
		expect(plain.SITE_ID).toMatch(/^site_/);
		expect(built.metadata.tags).toHaveLength(7);
		expect(built.metadata.tags).toContain(`s:${plain.SITE_ID}`);
		expect(built.metadata.tags).toContain('v:1.0.4');
		expect(built.metadata.tags).toContain('m:v2');
	});

	it('adds the assets token only when the session has produced one', () => {
		const without = buildDescriptor(input('managed'));
		expect(without.metadata.assets).toBeUndefined();
		const token = 'fake-completion-token';
		const withToken = buildDescriptor(
			input('managed', true, { release: { id: '1.0.4', assetsToken: token } })
		);
		expect(withToken.metadata.assets).toEqual({ jwt: token });
		const empty = buildDescriptor(
			input('managed', true, { release: { id: '1.0.4', assetsToken: '' } })
		);
		expect(empty.metadata.assets).toBeUndefined();
	});

	it('adds secrets as secret_text bindings in name order and does not mutate a later call', () => {
		const built = buildDescriptor(
			input('canonical', true, { secrets: { B_KEY: 'fake-b', A_KEY: 'fake-a' } })
		);
		const secrets = (built.metadata.bindings ?? []).filter((b) => b.type === 'secret_text');
		expect(secrets.map((b) => b.name)).toEqual(['A_KEY', 'B_KEY']);
		built.metadata.migrations!.length = 0;
		built.rules.length = 0;
		const again = buildDescriptor(input('canonical'));
		expect(again.metadata.migrations).toHaveLength(2);
		expect(again.rules).toHaveLength(3);
	});
});

describe('descriptor refusals', () => {
	const code = (fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			if (error instanceof DescriptorError) return error.code;
			throw error;
		}
		return null;
	};

	it('refuses a site id that is not one', () => {
		const base = input('managed');
		expect(code(() => buildDescriptor({ ...base, site: { ...base.site, id: 'nope' } }))).toBe(
			'invalid_site'
		);
	});

	it('refuses a resource that belongs to another site', () => {
		const base = input('managed');
		const other = input('managed');
		const resources = [
			{ ...base.resources[0]!, siteId: other.site.id },
			...base.resources.slice(1)
		];
		expect(code(() => buildDescriptor({ ...base, resources }))).toBe('foreign_resource');
	});

	it('refuses a resource given twice', () => {
		const base = input('managed');
		const resources = [...base.resources, base.resources[0]!];
		expect(code(() => buildDescriptor({ ...base, resources }))).toBe('duplicate_resource');
	});

	it('refuses the bucket on the canonical config and a binding of the wrong kind', () => {
		const managed = input('managed');
		const files = managed.resources.find((r) => r.binding === 'FILES')!;
		const canonical = input('canonical');
		const withBucket = [...canonical.resources, { ...files, siteId: canonical.site.id }];
		expect(code(() => buildDescriptor({ ...canonical, resources: withBucket }))).toBe(
			'unexpected_resource'
		);
		const wrong = canonical.resources.map((r) =>
			r.binding === 'PAGE_KV' ? { ...r, kind: 'd1' as const } : r
		);
		expect(code(() => buildDescriptor({ ...canonical, resources: wrong }))).toBe(
			'unexpected_resource'
		);
	});

	it('refuses a missing required resource', () => {
		const base = input('managed');
		const resources = base.resources.filter((r) => r.binding !== 'PAGE_KV');
		expect(code(() => buildDescriptor({ ...base, resources }))).toBe('missing_resource');
	});

	it('refuses a bad secret name and a secret that shadows a binding', () => {
		const base = input('managed');
		expect(code(() => buildDescriptor({ ...base, secrets: { 'bad name': 'x' } }))).toBe(
			'invalid_secret_name'
		);
		expect(code(() => buildDescriptor({ ...base, secrets: { PLAN: 'x' } }))).toBe(
			'secret_collision'
		);
		expect(code(() => buildDescriptor({ ...base, secrets: { FILES: 'x' } }))).toBe(
			'secret_collision'
		);
	});

	it('raises each code the descriptor lists', () => {
		const base = input('managed');
		const other = input('managed');
		const raised = new Set<string | null>([
			code(() => buildDescriptor({ ...base, site: { ...base.site, id: 'nope' } })),
			code(() =>
				buildDescriptor({
					...base,
					resources: [{ ...base.resources[0]!, siteId: other.site.id }]
				})
			),
			code(() =>
				buildDescriptor({ ...base, resources: [...base.resources, base.resources[0]!] })
			),
			code(() =>
				buildDescriptor({
					...base,
					resources: [...base.resources, { ...base.resources[0]!, binding: 'NOPE' }]
				})
			),
			code(() => buildDescriptor({ ...base, resources: [] })),
			code(() => buildDescriptor({ ...base, secrets: { 'bad name': 'x' } })),
			code(() => buildDescriptor({ ...base, secrets: { PLAN: 'x' } }))
		]);
		expect([...raised].sort()).toEqual([...DESCRIPTOR_ERROR_CODES].sort());
	});
});

describe('a recipe-driven Worker', () => {
	const SECRET = 'fake-api-token';
	const ASSETS_TOKEN = 'fake-assets-jwt';
	const recipe: RecipeBindings = {
		durableObjects: [{ name: 'JOBS', class_name: 'JobRunner' }],
		migrations: [{ tag: 'v1', new_sqlite_classes: ['JobRunner'] }],
		crons: ['0 3 * * *'],
		sendEmail: 'MAIL',
		versionMetadata: 'CF_VERSION_METADATA'
	};
	const build = (patch: Partial<DescriptorInput> = {}) =>
		buildDescriptor(
			input('canonical', true, { recipe, secrets: { API_TOKEN: SECRET }, ...patch })
		);

	it('binds the Durable Object, send_email and version metadata under the names the recipe gives', () => {
		const bindings = build().metadata.bindings ?? [];
		expect(bindings).toContainEqual({
			type: 'durable_object_namespace',
			name: 'JOBS',
			class_name: 'JobRunner'
		});
		expect(bindings).toContainEqual({ type: 'send_email', name: 'MAIL' });
		expect(bindings).toContainEqual({ type: 'version_metadata', name: 'CF_VERSION_METADATA' });
		expect(bindings.map((b) => b.name)).not.toContain('SEND_EMAIL');
	});

	it('carries the migration tags and the cron the recipe gives', () => {
		const built = build();
		expect(built.metadata.migrations).toEqual(recipe.migrations);
		expect(built.crons).toEqual(['0 3 * * *']);
	});

	it('tags the last migration tag so an update knows where the script is, and none without migrations', () => {
		expect(build().metadata.tags).toContain('m:v1');
		const bare = buildDescriptor(
			input('managed', true, { recipe: { ...recipe, migrations: [] } })
		);
		expect(bare.metadata.tags?.some((tag) => tag.startsWith('m:'))).toBe(false);
	});

	it('adds the secret as a secret_text binding', () => {
		expect(build().metadata.bindings).toContainEqual({
			type: 'secret_text',
			name: 'API_TOKEN',
			text: SECRET
		});
	});

	it('binds no send_email when the recipe names none', () => {
		const types = build({ recipe: { ...recipe, sendEmail: null } }).metadata.bindings?.map(
			(b) => b.type
		);
		expect(types).not.toContain('send_email');
	});

	it('redacts every secret from the loggable form and leaves the descriptor as it was', () => {
		const built = build({ release: { id: '1.0.4', assetsToken: ASSETS_TOKEN } });
		const loggable = JSON.stringify(redact(built));
		expect(loggable).not.toContain(SECRET);
		expect(loggable).not.toContain(ASSETS_TOKEN);
		expect(loggable).toContain('JobRunner');
		expect(JSON.stringify(built)).toContain(SECRET);
	});

	it('refuses a secret that has the name of a recipe binding', () => {
		let raised: unknown = null;
		try {
			build({ secrets: { JOBS: 'fake' } });
		} catch (error) {
			raised = error;
		}
		expect(raised).toBeInstanceOf(DescriptorError);
		expect((raised as DescriptorError).code).toBe('secret_collision');
	});
});
