import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_ENTRIES, SyncError, syncContracts } from '../../../scripts/sync-contracts';

let workspace: string;
let source: string;
let cwd: string;

function files(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((item) => item.isFile())
		.map((item) => join(item.parentPath, item.name).slice(dir.length + 1))
		.sort();
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), 'contracts-sync-'));
	cwd = join(workspace, 'dashboard');
	source = join(cwd, 'contracts');
	mkdirSync(join(source, 'src'), { recursive: true });
	mkdirSync(join(source, 'json-schema'));
	mkdirSync(join(source, 'vectors'));
	writeFileSync(join(source, 'src', 'common.ts'), 'export const a = 1;\n');
	writeFileSync(join(source, 'json-schema', 'common.json'), '{}\n');
	writeFileSync(join(source, 'vectors', 'fleet-link.json'), '{}\n');
	writeFileSync(join(source, 'README.md'), '# Contracts\n');
	writeFileSync(join(source, 'worker-requests.md'), 'dashboard only\n');
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe('syncContracts', () => {
	it('copies schemas, vectors and the readme into a sibling directory, and leaves worker-requests out', () => {
		const target = join(workspace, 'bastion', 'contracts');
		const result = syncContracts({ source, target, cwd });
		expect(result.copied.sort()).toEqual([
			'README.md',
			'json-schema/common.json',
			'src/common.ts',
			'vectors/fleet-link.json'
		]);
		expect(files(target)).toEqual(result.copied.sort());
		expect(readFileSync(join(target, 'src', 'common.ts'), 'utf8')).toBe(
			'export const a = 1;\n'
		);
		expect(SYNC_ENTRIES).toEqual(['src', 'json-schema', 'vectors', 'README.md']);
	});

	it('is idempotent and reports unchanged files on a second run', () => {
		const target = join(workspace, 'worker', 'contracts');
		syncContracts({ source, target, cwd });
		const again = syncContracts({ source, target, cwd });
		expect(again.copied).toEqual([]);
		expect(again.unchanged).toHaveLength(4);
	});

	it('refuses to overwrite a changed file, names it and writes nothing', () => {
		const target = join(workspace, 'bastion', 'contracts');
		syncContracts({ source, target, cwd });
		writeFileSync(join(target, 'src', 'common.ts'), 'edited\n');
		writeFileSync(join(source, 'README.md'), '# New readme\n');
		const attempt = () => syncContracts({ source, target, cwd });
		expect(attempt).toThrow(SyncError);
		try {
			attempt();
		} catch (error) {
			expect((error as SyncError).code).toBe('would_overwrite');
			expect((error as SyncError).files).toEqual(['README.md', 'src/common.ts']);
		}
		expect(readFileSync(join(target, 'src', 'common.ts'), 'utf8')).toBe('edited\n');
		expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Contracts\n');
	});

	it('overwrites a changed file with force', () => {
		const target = join(workspace, 'bastion', 'contracts');
		syncContracts({ source, target, cwd });
		writeFileSync(join(target, 'src', 'common.ts'), 'edited\n');
		const result = syncContracts({ source, target, cwd, force: true });
		expect(result.copied).toEqual(['src/common.ts']);
		expect(readFileSync(join(target, 'src', 'common.ts'), 'utf8')).toBe(
			'export const a = 1;\n'
		);
	});

	it('refuses a target outside the parent of the working directory unless allowed', () => {
		const outside = mkdtempSync(join(tmpdir(), 'contracts-outside-'));
		try {
			const nested = join(workspace, '..', 'elsewhere', 'contracts');
			for (const target of [outside, nested]) {
				try {
					syncContracts({ source, target, cwd });
					expect.unreachable();
				} catch (error) {
					expect(error).toBeInstanceOf(SyncError);
					expect((error as SyncError).code).toBe('outside_parent');
				}
			}
			expect(readdirSync(outside)).toEqual([]);
			const result = syncContracts({ source, target: outside, cwd, allowOutside: true });
			expect(result.copied).toHaveLength(4);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses the source directory as the target', () => {
		expect(() => syncContracts({ source, target: source, cwd })).toThrow(SyncError);
	});

	it('refuses a source that lacks an expected entry', () => {
		rmSync(join(source, 'vectors'), { recursive: true });
		try {
			syncContracts({ source, target: join(workspace, 'bastion', 'contracts'), cwd });
			expect.unreachable();
		} catch (error) {
			expect((error as SyncError).code).toBe('bad_source');
		}
	});
});
