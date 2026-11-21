import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

function vueFiles(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true })
		.map(String)
		.filter((file) => file.endsWith('.vue'))
		.map((file) => join(dir, file));
}

describe('main landmark', () => {
	it('is provided only by the layouts, never by a page or component', () => {
		const files = [...vueFiles('src/pages'), ...vueFiles('src/components')];
		const withMain = files.filter((file) =>
			/<main[\s>]/.test(readFileSync(join(ROOT, file), 'utf8'))
		);
		expect(withMain).toEqual([]);
	});
});
