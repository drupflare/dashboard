import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	rewriteSource,
	siblingDefault,
	SOURCES,
	syncDrangler,
	vendorDefault
} from '../../../scripts/sync-drangler';

const CONVERT =
	"import { ConvertError, UsageError } from '../errors';\nexport const convert = 1;\n";
const SURVEY =
	"import type { CommandResult } from '../host/exec';\n" +
	"import type { Transport } from './transport';\nexport const survey = 2;\n";
const ERRORS = 'export class ConvertError extends Error {}\n';

const clean = async () => [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('rewriteSource', () => {
	it('refuses a specifier that does not match exactly once', () => {
		expect(() =>
			rewriteSource("from '../errors';\nfrom '../errors';", SOURCES[0]!.rewrites)
		).toThrow(/expected one match/);
		expect(() => rewriteSource('export const x = 1;', SOURCES[0]!.rewrites)).toThrow(
			/expected one match/
		);
	});
});

describe('syncDrangler', () => {
	let dir: string;
	let sibling: string;
	let target: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sync-drangler-'));
		sibling = join(dir, 'drangler');
		target = join(dir, 'vendor');
		await mkdir(join(sibling, 'src', 'migrate'), { recursive: true });
		await writeFile(join(sibling, 'package.json'), JSON.stringify({ version: '9.9.9' }));
		await writeFile(join(sibling, 'src', 'migrate', 'convert.ts'), CONVERT);
		await writeFile(join(sibling, 'src', 'migrate', 'survey.ts'), SURVEY);
		await writeFile(join(sibling, 'src', 'errors.ts'), ERRORS);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('copies the sources with their specifiers rewritten and records the source hashes', async () => {
		const record = await syncDrangler(sibling, target, clean);

		expect(record.version).toBe('9.9.9');
		expect(await readFile(join(target, 'convert.ts'), 'utf8')).toBe(
			CONVERT.replace("from '../errors';", "from './errors';")
		);
		expect(await readFile(join(target, 'survey.ts'), 'utf8')).toBe(
			SURVEY.replace("from '../host/exec';", "from './types';").replace(
				"from './transport';",
				"from './types';"
			)
		);
		expect(await readFile(join(target, 'errors.ts'), 'utf8')).toBe(ERRORS);
		expect(record.files['convert.ts']).toEqual({
			source: 'src/migrate/convert.ts',
			sha256: hash(CONVERT)
		});
	});

	it('fails on a source whose specifier moved and writes nothing', async () => {
		await writeFile(
			join(sibling, 'src', 'migrate', 'survey.ts'),
			SURVEY.replace("'../host/exec'", "'../host/other'")
		);

		await expect(syncDrangler(sibling, target, clean)).rejects.toThrow(/expected one match/);
		expect(existsSync(join(target, 'convert.ts'))).toBe(false);
	});

	it('refuses to sync a modified source and writes nothing', async () => {
		const dirty = async () => [' M src/errors.ts'];

		await expect(syncDrangler(sibling, target, dirty)).rejects.toThrow(/refusing to sync/);
		expect(existsSync(target)).toBe(false);
	});
});

describe.skipIf(!existsSync(join(siblingDefault, 'src', 'migrate', 'survey.ts')))(
	'vendored drangler copy',
	() => {
		it('matches the sibling checkout after the same rewrite', async () => {
			const record = JSON.parse(
				await readFile(join(vendorDefault, 'VERSION.json'), 'utf8')
			) as { files: Record<string, { source: string; sha256: string }> };

			for (const source of SOURCES) {
				const raw = await readFile(join(siblingDefault, source.from), 'utf8');
				expect(record.files[source.to]?.sha256, source.to).toBe(hash(raw));
				const vendored = await readFile(join(vendorDefault, source.to), 'utf8');
				expect(vendored, source.to).toBe(rewriteSource(raw, source.rewrites));
			}
		});
	}
);
