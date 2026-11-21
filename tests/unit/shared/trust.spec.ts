import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUBPROCESSORS } from '../../../src/shared/trust';

const ROOT = join(import.meta.dirname, '../../..');

function trustCopy(): { file: string; text: string }[] {
	const files = [
		join(ROOT, 'src/shared/trust.ts'),
		join(ROOT, 'src/pages/trust.vue'),
		...readdirSync(join(ROOT, 'src/components/trust')).map((name) =>
			join(ROOT, 'src/components/trust', name)
		)
	];
	return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

describe('subprocessors', () => {
	it('names only integrations that exist in the repository', () => {
		for (const subprocessor of SUBPROCESSORS) {
			expect(subprocessor.integrations.length, subprocessor.name).toBeGreaterThan(0);
			for (const path of subprocessor.integrations) {
				expect(existsSync(join(ROOT, path)), `${subprocessor.name}: ${path}`).toBe(true);
			}
		}
	});
});

describe('trust copy', () => {
	it('makes no certification claim', () => {
		for (const { file, text } of trustCopy()) {
			expect(text.toLowerCase(), file).not.toContain('certified');
		}
	});
});
