import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTPUT, render } from '../../../scripts/gen-permissions';
import {
	ACTIONS,
	BASTION_ROLES,
	SESSION_ONLY_ACTIONS,
	actionDef
} from '../../../src/shared/permissions';

describe('gen-permissions', () => {
	it('matches the committed docs/reference/permissions.md', () => {
		expect(readFileSync(OUTPUT, 'utf8')).toBe(render());
	});

	it('lists every action once', () => {
		const text = render();
		for (const action of ACTIONS) {
			const hits = text.split(`\`${action}\``).length - 1;
			const expected =
				1 +
				(SESSION_ONLY_ACTIONS as readonly string[]).filter((a) => a === action).length +
				(actionDef(action).stepUp ? 1 : 0);
			expect(hits, action).toBe(expected);
		}
	});

	it('carries the bastion mapping', () => {
		const text = render();
		for (const [site, bastion] of Object.entries(BASTION_ROLES)) {
			expect(text).toContain(`site ${site}`);
			expect(text).toContain(bastion);
		}
		expect(text).toContain('never `operator`');
	});
});
