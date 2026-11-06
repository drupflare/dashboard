import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTPUT, render } from '../../../scripts/gen-catalogue';
import { CATALOGUE } from '../../../src/shared/health/catalogue';

describe('gen-catalogue', () => {
	it('matches the committed docs/reference/health-catalogue.md', () => {
		expect(readFileSync(OUTPUT, 'utf8')).toBe(render());
	});

	it('lists every catalogue row once, in its code cell', () => {
		const text = render();
		for (const id of CATALOGUE.keys()) {
			const cell = new RegExp(`^\\| \`${id.replace(/[.-]/g, '\\$&')}\` +\\|`, 'gm');
			expect(text.match(cell)?.length ?? 0, id).toBe(1);
		}
	});

	it('marks every unverified row in the table', () => {
		const text = render();
		for (const row of CATALOGUE.values()) {
			const line = new RegExp(
				`^\\| \`${row.repairId.replace(/[.-]/g, '\\$&')}\` .*\\| (yes|no)\\s*\\|$`,
				'm'
			);
			expect(text.match(line)?.[1], row.repairId).toBe(row.unverified ? 'yes' : 'no');
		}
	});
});
