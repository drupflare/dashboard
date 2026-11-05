import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderContractFiles } from '../../../scripts/gen-contracts';

const root = new URL('../../../', import.meta.url);

let rendered: Map<string, string>;

beforeAll(async () => {
	rendered = await renderContractFiles();
});

describe('generated contract files', () => {
	it('match what gen-contracts produces, so a schema change cannot land without a regenerate', () => {
		const stale: string[] = [];
		for (const [path, text] of rendered) {
			let onDisk: string | null = null;
			try {
				onDisk = readFileSync(new URL(path, root), 'utf8');
			} catch {
				onDisk = null;
			}
			if (onDisk !== text) stale.push(path);
		}
		expect(stale, 'run bun scripts/gen-contracts.ts').toEqual([]);
	});

	it('leave no committed file that the generator no longer produces', () => {
		for (const dir of ['json-schema', 'vectors']) {
			const files = readdirSync(new URL(`contracts/${dir}/`, root)).map(
				(f) => `contracts/${dir}/${f}`
			);
			for (const file of files) expect(rendered.has(file), file).toBe(true);
		}
	});

	it('are deterministic across runs', async () => {
		const again = await renderContractFiles();
		expect([...again]).toEqual([...rendered]);
	});

	it('write a json schema file for every contract in the plan tree', () => {
		const names = [...rendered.keys()]
			.filter((p) => p.startsWith('contracts/json-schema/'))
			.map((p) => p.slice('contracts/json-schema/'.length, -'.json'.length));
		expect(names.sort()).toEqual(
			[
				'common',
				'discovery',
				'fleet-link',
				'migration-cutover',
				'operations',
				'owner-assertion',
				'releases',
				'site-auth',
				'site-db-console',
				'sites',
				'templates',
				'usage',
				'webhooks'
			].sort()
		);
	});

	it('name the contract and version inside each json schema file and hold at least one schema', () => {
		for (const [path, text] of rendered) {
			if (!path.startsWith('contracts/json-schema/')) continue;
			const file = JSON.parse(text);
			expect(path).toBe(`contracts/json-schema/${file.contract}.json`);
			expect(file.version).toMatch(/^\d+\.\d+$/);
			expect(Object.keys(file.schemas).length).toBeGreaterThan(0);
			for (const schema of Object.values(file.schemas) as Record<string, unknown>[]) {
				expect(schema.$schema).toBeUndefined();
			}
		}
	});

	it('describe the two envelope unions with one branch per message type', () => {
		const file = JSON.parse(rendered.get('contracts/json-schema/fleet-link.json')!);
		const branches = (s: any) => (s.oneOf ?? s.anyOf).length;
		expect(branches(file.schemas.nodeEnvelope)).toBe(6);
		expect(file.schemas.serverEnvelope.properties.type.const).toBe('command');
	});

	it('never write a seed into a json schema file and mark every vector key as a test key', () => {
		for (const [path, text] of rendered) {
			if (path.includes('json-schema')) expect(text).not.toContain('seed');
			if (path.includes('vectors')) {
				const file = JSON.parse(text);
				for (const key of Object.values(file.keys) as { note: string }[]) {
					expect(key.note).toMatch(/^TEST KEY ONLY/);
				}
			}
		}
	});
});
