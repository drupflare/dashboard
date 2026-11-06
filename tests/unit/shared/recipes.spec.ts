import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listRecipes, recipeFor, recipeSchema, type Recipe } from '../../../src/shared/recipes';
import { inferRecipe } from '../../../src/shared/recipes/custom';
import { TEMPLATES } from '../../../src/shared/templates';

type PasswordClass = 'lower' | 'upper' | 'digit' | 'symbol';

const NO_RECIPE: Record<string, string> = {
	'bring-your-own': 'inferRecipe builds it from a config, see custom.ts'
};

const SOURCE_RE = /^[A-Za-z0-9@-]+\/[A-Za-z0-9./_-]+:\d+$/;

const CLASS_CHARS: Record<PasswordClass, string> = {
	lower: 'abcdefghijklmnopqrstuvwxyz',
	upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
	digit: '0123456789',
	symbol: '!#$%&*+-=?@^_~'
};

const CLASS_RE: Record<PasswordClass, RegExp> = {
	lower: /[a-z]/,
	upper: /[A-Z]/,
	digit: /\d/,
	symbol: /[!-/:-@[-`{-~]/
};

const BASE = {
	d1_databases: [{ binding: 'DB' }],
	kv_namespaces: [{ binding: 'KV' }],
	r2_buckets: [{ binding: 'BLOB' }]
};

function pick(chars: string): string {
	const index = crypto.getRandomValues(new Uint32Array(1))[0]! % chars.length;
	return chars[index]!;
}

function sampleSecret(rule: Recipe['secrets'][number]): string {
	if (rule.encoding === 'hex') {
		const bytes = crypto.getRandomValues(new Uint8Array(rule.length / 2));
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	const bytes = crypto.getRandomValues(new Uint8Array((rule.length / 4) * 3));
	return btoa(String.fromCharCode(...bytes));
}

function samplePassword(length: number, requires: readonly PasswordClass[]): string {
	const all = Object.values(CLASS_CHARS).join('');
	const out = requires.map((cls) => pick(CLASS_CHARS[cls]));
	while (out.length < length) out.push(pick(all));
	return out.join('');
}

function provenanceNodes(value: unknown, found: Record<string, unknown>[] = []) {
	if (Array.isArray(value)) {
		for (const item of value) provenanceNodes(item, found);
	} else if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if ('provenance' in record) found.push(record.provenance as Record<string, unknown>);
		for (const item of Object.values(record)) provenanceNodes(item, found);
	}
	return found;
}

function blocking(config: Record<string, unknown>) {
	return inferRecipe(config).findings.filter((f) => f.severity === 'blocking');
}

describe('recipes', () => {
	it.each(listRecipes().map((recipe) => [recipe.id, recipe] as const))(
		'%s parses against the recipe schema',
		(_id, recipe) => {
			expect(recipeSchema.safeParse(recipe).success).toBe(true);
		}
	);

	it('gives every fact a source file and line, or flags it unverified', () => {
		for (const recipe of listRecipes()) {
			const nodes = provenanceNodes(recipe);
			expect(nodes.length, recipe.id).toBeGreaterThan(0);
			for (const node of nodes) {
				if ('source' in node) {
					expect(String(node.source), recipe.id).toMatch(SOURCE_RE);
				} else {
					expect(node.unverified, recipe.id).toBe(true);
					expect(String(node.confirm), recipe.id).not.toBe('');
				}
			}
		}
	});

	it('agrees with the template catalogue', () => {
		for (const template of TEMPLATES) {
			if (!template.enabled) continue;
			if (NO_RECIPE[template.id]) {
				expect(recipeFor(template.id), template.id).toBeUndefined();
			} else {
				expect(recipeFor(template.id), template.id).toBeDefined();
			}
		}
		for (const id of Object.keys(NO_RECIPE)) {
			expect(TEMPLATES.find((t) => t.id === id)?.enabled, id).toBe(true);
		}
		for (const recipe of listRecipes()) {
			expect(
				TEMPLATES.some((t) => t.id === recipe.id),
				recipe.id
			).toBe(true);
		}
		expect(recipeFor('no-such-kind')).toBeUndefined();
	});

	it('keeps secret rules as data and never values', () => {
		for (const recipe of listRecipes()) {
			for (const rule of recipe.secrets) expect(Object.keys(rule)).not.toContain('value');
			expect(JSON.stringify(recipe)).not.toMatch(/[A-Za-z0-9]{40,}/);
		}
	});

	it('generates secrets that match their stated length and encoding', () => {
		for (const recipe of listRecipes()) {
			for (const rule of recipe.secrets) {
				expect(rule.length % (rule.encoding === 'hex' ? 2 : 4), rule.name).toBe(0);
				const value = sampleSecret(rule);
				expect(value, rule.name).toHaveLength(rule.length);
				expect(value, rule.name).toMatch(
					rule.encoding === 'hex' ? /^[0-9a-f]+$/ : /^[A-Za-z0-9+/]+$/
				);
			}
		}
	});

	it('sizes the session secret at or above the 32 characters the apps read', () => {
		for (const recipe of listRecipes()) {
			for (const rule of recipe.secrets) {
				if (rule.name === 'NUXT_SESSION_PASSWORD')
					expect(rule.length, recipe.id).toBeGreaterThanOrEqual(32);
			}
		}
	});

	it('generates first-run passwords that meet the rules each app enforces', () => {
		for (const recipe of listRecipes()) {
			if (!recipe.firstRun) continue;
			const { password } = recipe.firstRun;
			const length = password.generatedLength.value;
			if (password.minLength !== null)
				expect(length, recipe.id).toBeGreaterThanOrEqual(password.minLength);
			if (password.maxLength !== null)
				expect(length, recipe.id).toBeLessThanOrEqual(password.maxLength);
			const sample = samplePassword(length, password.requires);
			for (const cls of password.requires) expect(sample, recipe.id).toMatch(CLASS_RE[cls]);
		}
	});

	it('keeps the MyLoRA Workers AI binding as the only refusal among first-party recipes', () => {
		expect(recipeFor('mylora')?.refused.map((r) => r.kind)).toEqual(['ai']);
		expect(recipeFor('nuxtpress')?.refused).toEqual([]);
		expect(recipeFor('smoke')?.refused).toEqual([]);
	});

	it('separates required resources from optional ones for smoke', () => {
		const smoke = recipeFor('smoke');
		const required = smoke?.resources.filter((r) => !r.optional).map((r) => r.binding);
		const optional = smoke?.resources.filter((r) => r.optional).map((r) => r.binding);
		expect(required).toEqual(['DB', 'KV', 'CACHE', 'BLOB']);
		expect(optional).toEqual(['DB_SECONDARY', 'DB_TERTIARY']);
	});

	it('gives the static site assets only', () => {
		const site = recipeFor('static-site');
		expect(site?.resources).toEqual([]);
		expect(site?.durableObjects).toEqual([]);
		expect(site?.secrets).toEqual([]);
		expect(site?.firstRun).toBeNull();
		expect(site?.probe.path).toBe('/');
		expect(site?.assets.directory).toBeNull();
	});

	it('keeps every settings field read-only with a positive bound', () => {
		for (const recipe of listRecipes()) {
			for (const field of recipe.settings) {
				expect(field.access, recipe.id).toBe('read-only');
				expect(field.maxLength, recipe.id).toBeGreaterThan(0);
			}
		}
	});
});

describe('the drupal recipe', () => {
	const drupal = () => recipeFor('drupal')!;

	it('states the Durable Object classes, migration tags, cron and resources of the managed config', () => {
		const recipe = drupal();
		expect(recipe.durableObjects.map((d) => [d.binding, d.className])).toEqual([
			['SITE', 'SitePhpDurableObject'],
			['RENDER_LANES', 'RenderLane']
		]);
		expect(recipe.durableMigrations.map((m) => [m.tag, m.newSqliteClasses])).toEqual([
			['v1', ['SitePhpDurableObject']],
			['v2', ['RenderLane']]
		]);
		expect(recipe.crons.map((c) => c.schedule)).toEqual(['*/5 * * * *']);
		expect(recipe.resources.map((r) => [r.kind, r.binding, r.optional])).toEqual([
			['kv', 'CONFIG_KV', false],
			['kv', 'PAGE_KV', false],
			['d1', 'FLEET_DB', true],
			['r2', 'FILES', false],
			['r2', 'FILES_PRIVATE', false],
			['send_email', 'SEND_EMAIL', false]
		]);
	});

	it('agrees with the managed config fixture on the bindings it states', () => {
		const file = JSON.parse(
			readFileSync(
				new URL('../engine/fixtures/wrangler.managed.jsonc', import.meta.url),
				'utf8'
			)
		) as {
			durable_objects: { bindings: { name: string; class_name: string }[] };
			migrations: { tag: string; new_sqlite_classes: string[] }[];
			triggers: { crons: string[] };
			send_email: { name: string }[];
			version_metadata: { binding: string };
		};
		const recipe = drupal();
		expect(
			recipe.durableObjects.map((d) => ({ name: d.binding, class_name: d.className }))
		).toEqual(file.durable_objects.bindings);
		expect(
			recipe.durableMigrations.map((m) => ({
				tag: m.tag,
				new_sqlite_classes: m.newSqliteClasses
			}))
		).toEqual(file.migrations);
		expect(recipe.crons.map((c) => c.schedule)).toEqual(file.triggers.crons);
		expect(
			recipe.resources.filter((r) => r.kind === 'send_email').map((r) => r.binding)
		).toEqual(file.send_email.map((s) => s.name));
		expect(recipe.versionMetadata?.binding).toBe(file.version_metadata.binding);
	});

	it('marks the variables the dashboard sets rather than the owner', () => {
		const marked = drupal()
			.variables.filter((v) => v.platformSet)
			.map((v) => v.name)
			.sort();
		expect(marked).toEqual(['CACHE_API', 'FILE_STORE', 'PLAN', 'SITE_ID', 'SITE_ID_PORTS']);
	});

	it('claims through POST /firstrun with three optional fields and probes /health with the owner token', () => {
		const recipe = drupal();
		expect(recipe.firstRun?.method).toBe('POST');
		expect(recipe.firstRun?.path).toBe('/firstrun');
		expect(recipe.firstRun?.body.map((f) => f.name)).toEqual([
			'siteName',
			'adminMail',
			'adminPass'
		]);
		expect(recipe.firstRun?.body.every((f) => !f.required)).toBe(true);
		expect(recipe.probe).toMatchObject({ method: 'GET', path: '/health', auth: 'owner-token' });
	});

	it('sets no password rule and shows the minted password once', () => {
		const { password } = drupal().firstRun!;
		expect(password.minLength).toBeNull();
		expect(password.maxLength).toBeNull();
		expect(password.requires).toEqual([]);
		expect(password.generatedLength.value).toBe(24);
		expect(password.delivery).toBe('shown-once');
	});

	it('shows the owner token once and names where the dashboard keeps it', () => {
		const token = drupal().firstRun!.ownerToken;
		expect(token?.responseField).toBe('ownerToken');
		expect(token?.delivery).toBe('shown-once');
		expect(token?.custody.store).toMatch(/encrypted/);
	});
});

describe('inferRecipe', () => {
	it('accepts a config of only D1, KV and R2', () => {
		const result = inferRecipe(BASE);
		expect(result.deployable).toBe(true);
		expect(result.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
		expect(result.recipe.resources.map((r) => r.kind).sort()).toEqual(['d1', 'kv', 'r2']);
		expect(recipeSchema.safeParse(result.recipe).success).toBe(true);
	});

	it.each([
		['ai', { binding: 'AI' }],
		['containers', [{ class_name: 'Box', image: './Dockerfile' }]],
		['browser', { binding: 'BROWSER' }],
		['hyperdrive', [{ binding: 'HYPER', id: 'abc' }]],
		['vectorize', [{ binding: 'VEC', index_name: 'docs' }]],
		['tail_consumers', [{ service: 'logs' }]],
		['analytics_engine_datasets', [{ binding: 'AE', dataset: 'events' }]]
	])('refuses a %s binding with a reason', (key, value) => {
		const result = inferRecipe({ ...BASE, [key]: value });
		expect(result.deployable).toBe(false);
		const finding = result.findings.find((f) => f.subject === key && f.severity === 'blocking');
		expect(finding?.reason ?? '').toMatch(/\w/);
	});

	it('refuses a service binding and a queue consumer', () => {
		expect(
			blocking({ ...BASE, services: [{ binding: 'OTHER', service: 'other' }] }).map(
				(f) => f.subject
			)
		).toEqual(['services']);
		expect(
			blocking({ ...BASE, queues: { consumers: [{ queue: 'jobs' }] } }).map((f) => f.subject)
		).toEqual(['queues']);
	});

	it('refuses a migration step it cannot verify', () => {
		const config = { ...BASE, migrations: [{ tag: 'v1', deleted_classes: ['Old'] }] };
		expect(blocking(config).map((f) => f.subject)).toEqual(['migrations']);
	});

	it('flags cron triggers as unobserved without refusing the config', () => {
		const result = inferRecipe({ ...BASE, triggers: { crons: ['*/5 * * * *'] } });
		expect(result.deployable).toBe(true);
		const finding = result.findings.find((f) => f.code === 'cron-unobserved');
		expect(finding?.severity).toBe('warning');
	});

	it('says connect() cannot be seen from a config', () => {
		const finding = inferRecipe(BASE).findings.find((f) => f.code === 'connect-unseen');
		expect(finding?.reason).toContain('connect()');
	});
});
