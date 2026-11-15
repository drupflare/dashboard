import { describe, expect, it } from 'vitest';
import { BUNDLE_ERROR_CODES } from '../../../engine/src/bundle';
import { buildCustomBundle, unpackArchive } from '../../../engine/src/custom-bundle';
import {
	ARCHIVE_REASON_COPY,
	BUNDLE_ERROR_CODE_LIST,
	explainFinding,
	FINDING_COPY,
	GENERIC_FINDING
} from '../../../src/shared/custom-findings';
import { goodFiles, tarGz, TODAY } from '../engine/custom-fixtures';

const BANNED = /cloudflare|durable object|dispatch|namespace/i;

async function build(overrides: Record<string, unknown>) {
	return buildCustomBundle({
		files: await unpackArchive(await tarGz(goodFiles(overrides))),
		archiveSha256: 'a'.repeat(64),
		releaseId: 'cust-test',
		today: TODAY
	});
}

const MESSY = [
	{ main: undefined },
	{ main: 'src/index.ts' },
	{ main: 'dist/missing.js' },
	{ compatibility_date: undefined },
	{ compatibility_date: 'soon' },
	{ compatibility_date: '2099-01-01' },
	{ ai: { binding: 'AI' } },
	{ kv_namespaces: 'no' },
	{ kv_namespaces: [{ binding: '1bad', id: 'x' }] },
	{
		kv_namespaces: [
			{ binding: 'CACHE', id: 'x' },
			{ binding: 'CACHE', id: 'y' }
		]
	},
	{ r2_buckets: [{ binding: 'A'.repeat(40), bucket_name: 'x' }] },
	{ durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room', script_name: 'other' }] } },
	{ durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] } },
	{ vars: { BAD: { nested: true } } },
	{ services: [{ binding: 'SVC', service: 'other' }] },
	{ triggers: { crons: ['* * * * *'] } },
	{ queues: { producers: [{ queue: 'q', binding: 'Q' }] } },
	{ routes: ['example.com/*'] },
	{ env: { staging: {} } },
	{ limits: { cpu_ms: 10 } },
	{ placement: { mode: 'smart' } },
	{ d1_databases: [{ binding: 'DB', database_id: 'x', migrations_dir: 'm' }] },
	{ assets: { directory: 'dist/empty' } }
];

describe('plain findings', () => {
	it('explains every finding the inference and the build emit', async () => {
		const emitted = new Set<string>();
		for (const overrides of MESSY) {
			for (const finding of (await build(overrides)).findings) emitted.add(finding.code);
		}
		expect(emitted.size).toBeGreaterThan(15);
		for (const code of emitted) {
			expect(FINDING_COPY[code], `no plain copy for ${code}`).toBeDefined();
		}
	});

	it('covers the engine bundle error codes and no others', () => {
		expect([...BUNDLE_ERROR_CODE_LIST].sort()).toEqual([...BUNDLE_ERROR_CODES].sort());
	});

	it('uses no platform words and names a change for each refusal code', () => {
		for (const [code, copy] of Object.entries({ ...FINDING_COPY, generic: GENERIC_FINDING })) {
			expect(copy.title, code).not.toMatch(BANNED);
			expect(copy.change ?? '', code).not.toMatch(BANNED);
		}
		for (const text of Object.values(ARCHIVE_REASON_COPY)) expect(text).not.toMatch(BANNED);
		expect(explainFinding({ code: 'brand-new' })).toBe(GENERIC_FINDING);
		expect(FINDING_COPY['main-not-built']!.change).toContain('Build');
	});
});
