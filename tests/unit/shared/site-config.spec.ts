import type { DiscoveryDocument } from '@contracts/discovery';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toFields, validate } from '~/shared/site-config/form';
import {
	isKvWritable,
	isOwnerOnly,
	KV_OVERRIDABLE_NAMES,
	OWNER_ONLY_NAMES,
	SITE_CONFIG_REGISTRY
} from '~/shared/site-config/registry';

function settingsBlock(overrides: Partial<DiscoveryDocument['settings']> = {}) {
	const block: DiscoveryDocument['settings'] = {
		schema: {
			WARM_INTERVAL_MS: {
				type: 'integer',
				minimum: 8000,
				maximum: 600000,
				default: 8000,
				'x-ui': { group: 'runtime', permission: 'runtime', widget: 'lever-slider' }
			},
			SPOOL: {
				type: 'string',
				enum: ['0', '1'],
				'x-ui': { group: 'security', permission: 'security', danger: false }
			},
			CSP_MODE: {
				type: 'string',
				enum: ['off', 'report-only', 'enforce'],
				'x-ui': { group: 'security', permission: 'security', danger: true }
			},
			HOLOGRAM: {
				type: 'string',
				'x-ui': { group: 'runtime', permission: 'runtime', widget: 'hologram-grid' }
			}
		},
		values: { WARM_INTERVAL_MS: 30000, SPOOL: '0', CSP_MODE: null, HOLOGRAM: 'x' },
		provenance: { WARM_INTERVAL_MS: 'kv', SPOOL: 'kv', CSP_MODE: 'default', HOLOGRAM: 'var' },
		writable: { WARM_INTERVAL_MS: 'kv', SPOOL: 'kv', CSP_MODE: 'kv', HOLOGRAM: 'kv' },
		etag: '"fixture"',
		...overrides
	};
	return block;
}

describe('site config registry', () => {
	it('keeps PLAN out of every list', () => {
		expect(KV_OVERRIDABLE_NAMES).not.toContain('PLAN');
		expect(Object.keys(SITE_CONFIG_REGISTRY)).not.toContain('PLAN');
		expect(isKvWritable('PLAN')).toBe(false);
	});

	it('limits writes to the worker allow-list', () => {
		expect(isKvWritable('WARM_INTERVAL_MS')).toBe(true);
		expect(isKvWritable('WRITE_FORWARD')).toBe(false);
		expect(isKvWritable('SMTP_HOST')).toBe(false);
	});

	it('marks the worker owner-only levers and keeps them on the allow-list', () => {
		for (const name of OWNER_ONLY_NAMES) {
			expect(isOwnerOnly(name)).toBe(true);
			expect(isKvWritable(name)).toBe(true);
		}
		expect(isOwnerOnly('WARM_INTERVAL_MS')).toBe(false);
	});

	it('keeps every registry entry that claims a KV layer on the allow-list', () => {
		for (const [name, entry] of Object.entries(SITE_CONFIG_REGISTRY)) {
			if (entry.layer === 'kv') expect(isKvWritable(name)).toBe(true);
			else expect(isKvWritable(name)).toBe(false);
		}
	});

	it('agrees with the captured worker settings shape on every bound it names', () => {
		const levers = (
			JSON.parse(
				readFileSync(
					new URL('../server/fixtures/discovery/settings-response.json', import.meta.url),
					'utf8'
				)
			) as {
				levers: {
					name: string;
					domain: { kind: string; min?: number; max?: number; default?: unknown };
				}[];
			}
		).levers;
		for (const [name, entry] of Object.entries(SITE_CONFIG_REGISTRY)) {
			if (entry.layer !== 'kv') continue;
			const lever = levers.find((l) => l.name === name);
			expect(lever, name).toBeDefined();
			if (entry.domain.kind === 'int') {
				expect(lever?.domain).toMatchObject({
					min: entry.domain.min,
					max: entry.domain.max
				});
			}
		}
	});

	it('states the warm ceiling default and marks the trial', () => {
		const entry = SITE_CONFIG_REGISTRY['WARM_CEILING_MS'];
		expect(entry?.domain).toMatchObject({ kind: 'int', default: 9500 });
		expect(entry?.note).toMatch(/trial/i);
	});
});

describe('toFields', () => {
	it('maps a known widget and keeps the registry-driven bounds', () => {
		const fields = toFields(settingsBlock(), 'site-admin');
		const warm = fields.find((f) => f.key === 'WARM_INTERVAL_MS');
		expect(warm).toMatchObject({
			widget: 'lever-slider',
			bounds: { min: 8000, max: 600000 },
			provenance: 'kv',
			writable: true
		});
	});

	it('falls back to a JSON editor for an unknown widget', () => {
		const fields = toFields(settingsBlock(), 'site-admin');
		expect(fields.find((f) => f.key === 'HOLOGRAM')?.widget).toBe('json');
	});

	it('makes an owner-only lever read-only for a role without the security group', () => {
		const maintainer = toFields(settingsBlock(), 'maintainer').find(
			(f) => f.key === 'CSP_MODE'
		);
		expect(maintainer).toMatchObject({ permission: 'security', writable: false });
		const admin = toFields(settingsBlock(), 'site-admin').find((f) => f.key === 'CSP_MODE');
		expect(admin).toMatchObject({ permission: 'security', writable: true });
	});

	it('makes every field read-only for a viewer', () => {
		const fields = toFields(settingsBlock(), 'viewer');
		expect(fields.every((f) => f.writable === false)).toBe(true);
	});

	it('marks a danger lever', () => {
		const fields = toFields(settingsBlock(), 'site-admin');
		expect(fields.find((f) => f.key === 'CSP_MODE')?.danger).toBe(true);
	});

	it('never emits PLAN as a field', () => {
		const block = settingsBlock({
			writable: { PLAN: 'kv' },
			values: { PLAN: 'paid' },
			provenance: { PLAN: 'kv' },
			schema: {}
		});
		expect(toFields(block, 'site-admin').map((f) => f.key)).not.toContain('PLAN');
	});
});

describe('validate', () => {
	const fields = toFields(settingsBlock(), 'site-admin');

	it('accepts an in-range integer', () => {
		expect(validate(fields, { WARM_INTERVAL_MS: 30000 })).toEqual({ ok: true });
	});

	it('rejects an integer outside the bounds, naming the key', () => {
		const out = validate(fields, { WARM_INTERVAL_MS: 1000 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.map((e) => e.key)).toEqual(['WARM_INTERVAL_MS']);
	});

	it('rejects a flag value that is not 0 or 1', () => {
		expect(validate(fields, { SPOOL: '7' }).ok).toBe(false);
	});

	it('accepts null as clearing the override', () => {
		expect(validate(fields, { WARM_INTERVAL_MS: null })).toEqual({ ok: true });
	});

	it('refuses a key that is not a field', () => {
		const out = validate(fields, { PLAN: 'paid' });
		expect(out.ok).toBe(false);
	});

	it('refuses a read-only field for a lower role', () => {
		const maintainer = toFields(settingsBlock(), 'maintainer');
		const out = validate(maintainer, { CSP_MODE: 'enforce' });
		expect(out.ok).toBe(false);
	});
});

const WORKER_PLAN = fileURLToPath(new URL('../../../../worker/src/ops/plan.ts', import.meta.url));

// the quoted names between an opener and its closer, with comment lines skipped
function quotedNames(source: string, opener: string, closer: string): string[] {
	const start = source.indexOf(opener);
	if (start < 0) throw new Error(`the worker source has no ${opener}`);
	const end = source.indexOf(closer, start + opener.length);
	if (end < 0) throw new Error(`the worker source has no end to ${opener}`);
	const body = source
		.slice(start + opener.length, end)
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n');
	return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string).sort();
}

// the names on one side only, sorted
function drift(worker: readonly string[], mirror: readonly string[]): string[] {
	const all = new Set([...worker, ...mirror]);
	return [...all].filter((name) => !(worker.includes(name) && mirror.includes(name))).sort();
}

describe('worker drift', () => {
	const present = existsSync(WORKER_PLAN);
	const absent = `the worker source is not at ${WORKER_PLAN}, so the lists are not compared`;

	it('matches KV_OVERRIDABLE in the worker', (ctx) => {
		if (!present) ctx.skip(absent);
		const worker = quotedNames(
			readFileSync(WORKER_PLAN, 'utf8'),
			'export const KV_OVERRIDABLE = [',
			'] as const;'
		);
		expect(drift(worker, KV_OVERRIDABLE_NAMES)).toEqual([]);
	});

	it('matches OWNER_ONLY_LEVERS in the worker', (ctx) => {
		if (!present) ctx.skip(absent);
		const worker = quotedNames(
			readFileSync(WORKER_PLAN, 'utf8'),
			'export const OWNER_ONLY_LEVERS: ReadonlySet<string> = new Set<KvOverridable>([',
			']);'
		);
		expect(drift(worker, OWNER_ONLY_NAMES)).toEqual([]);
	});

	it('reports the name that one side has and the other does not', () => {
		const worker = KV_OVERRIDABLE_NAMES.filter((name) => name !== 'SPOOL');
		expect(drift(worker, KV_OVERRIDABLE_NAMES)).toEqual(['SPOOL']);
	});
});
