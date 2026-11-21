import { describe, expect, it } from 'vitest';
import {
	CALLS_PER_TRIAL,
	MECHANISMS,
	costs,
	countingTable,
	loadSheet,
	mechanismCost
} from '../../../scripts/economics/counting';

const sheet = loadSheet();

describe('counting cost by mechanism', () => {
	it('prices write-through at one counter request a view', () => {
		const cost = mechanismCost('write-through', sheet);
		expect(cost.requests.low.value).toBe(1_000_000);
		expect(cost.requests.high.value).toBe(1_000_000);
		expect(cost.requests.low.label).toBe('derived');
	});

	it('scales the measured calls of a 3,000-view trial to a million views', () => {
		const batched = mechanismCost('batched', sheet);
		expect(batched.requests.low.value).toBeCloseTo((84 / 3000) * 1e6, 6);
		expect(batched.requests.high.value).toBeCloseTo((167 / 3000) * 1e6, 6);
		const hybrid = mechanismCost('hybrid', sheet);
		expect(hybrid.requests.low.value).toBeCloseTo((172 / 3000) * 1e6, 6);
		expect(hybrid.requests.high.value).toBeCloseTo((205 / 3000) * 1e6, 6);
		expect(batched.requests.low.label).toBe('measured');
	});

	it('costs requests and rows at the sheet rates with no allowance', () => {
		const cost = mechanismCost('write-through', sheet);
		const expected =
			sheet.doRequests.usdPerMillion * 1 +
			sheet.rowsWritten.usdPerMillion * 2 +
			sheet.rowsRead.usdPerMillion * 2;
		expect(cost.usd.low.value).toBeCloseTo(expected, 9);
		expect(cost.usd.low.label).toBe('derived');
		expect(cost.rowsWritten.low.label).toBe('assumption');
	});

	it('orders the mechanisms by cost', () => {
		const [write, batched, hybrid] = costs(sheet);
		expect(MECHANISMS).toHaveLength(3);
		expect(batched?.usd.high.value).toBeLessThan(hybrid?.usd.low.value ?? 0);
		expect(hybrid?.usd.high.value).toBeLessThan(write?.usd.low.value ?? 0);
		expect(CALLS_PER_TRIAL.hybrid.low).toBeGreaterThan(CALLS_PER_TRIAL.batched.low);
	});

	it('prints a table with a label on every figure', () => {
		const lines = countingTable(sheet).split('\n');
		expect(lines).toHaveLength(5);
		for (const row of lines.slice(2)) {
			expect(row.match(/\((published|measured|derived|assumption)\)/g)).toHaveLength(4);
		}
	});
});
