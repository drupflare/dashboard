import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT, render } from '../../../scripts/gen-effort';
import { EFFORT, EFFORT_STATES } from '../../../src/shared/effort';

const ROOT = join(import.meta.dirname, '../../..');

const requests = new Set(
	[
		...readFileSync(join(ROOT, 'contracts/worker-requests.md'), 'utf8').matchAll(
			/^\|\s*(\d+)\s*\|/gm
		)
	].map((m) => Number(m[1]))
);

describe('effort ledger', () => {
	it('gives every row a unique id', () => {
		const ids = EFFORT.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('names a request that exists for every blocked row, and none for the rest', () => {
		for (const row of EFFORT) {
			if (row.state === 'blocked') {
				expect(row.blockedBy, row.id).not.toBeNull();
				expect(requests.has(row.blockedBy!), row.id).toBe(true);
			} else {
				expect(row.blockedBy, row.id).toBeNull();
			}
		}
	});

	it('gives every one-button row a dashboard operation', () => {
		for (const row of EFFORT.filter((r) => r.state === 'one-button')) {
			expect(row.dashboardOperation, row.id).not.toBe('none');
		}
	});

	it('uses only the three states and fills every text field', () => {
		for (const row of EFFORT) {
			expect(EFFORT_STATES, row.id).toContain(row.state);
			expect(row.screens, row.id).toBeGreaterThanOrEqual(0);
			expect(row.mustKnowToday.length, row.id).toBeGreaterThan(0);
			for (const text of [row.task, row.leftAfter, row.scheduled, row.workerRoute]) {
				expect(text.trim(), row.id).not.toBe('');
			}
		}
	});
});

describe('effort reference page', () => {
	it('equals the generator output, so a ledger change cannot land without a regenerate', () => {
		expect(readFileSync(OUTPUT, 'utf8')).toBe(render());
	});
});
