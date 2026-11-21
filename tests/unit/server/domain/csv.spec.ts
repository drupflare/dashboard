import { describe, expect, it } from 'vitest';
import { csvField } from '../../../../src/server/domain/client-usage';
import { csvCell, csvLines } from '../../../../src/server/domain/csv';
import { toCsv } from '../../../../src/server/domain/estate';

const HOSTILE = [
	'=1+1',
	'+1+1',
	'-1+1',
	'@SUM(1)',
	'\t=1+1',
	'\r=1+1',
	'=HYPERLINK("http://x","y")',
	"=cmd|' /C calc'!A0"
];

// a parsed cell can only start a formula if its first character is one of these
const FORMULA_START = /^[=+\-@\t\r]/;

function firstCharsOf(line: string): string[] {
	const out: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i <= line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c ?? '';
		} else if (c === ',' || c === undefined) {
			out.push(cell);
			cell = '';
		} else if (c === '"' && cell === '') quoted = true;
		else cell += c;
	}
	return out;
}

describe('csv writers', () => {
	it.each(HOSTILE)('csvCell keeps %j as text', (value) => {
		for (const cell of firstCharsOf(csvCell(value))) expect(cell).not.toMatch(FORMULA_START);
	});

	it.each(HOSTILE)('the client usage writer and the shared writer agree on %j', (value) => {
		expect(csvField(value)).toBe(csvCell(value));
	});

	it('guards every cell of a multi-row file', () => {
		const text = csvLines(HOSTILE.map((value) => [value, 'ok', 1, null]));
		for (const line of text.trim().split('\r\n')) {
			for (const cell of firstCharsOf(line)) expect(cell).not.toMatch(FORMULA_START);
		}
	});

	it('guards the inventory export through the same writer', () => {
		const site = {
			number: 1,
			input: new Proxy({}, { get: () => HOSTILE[0] })
		};
		const verdict = {
			class: 'a',
			state: 'b',
			basis: 'c',
			reconciled: true,
			findings: [{ title: '=title', detail: 'd' }],
			missing: '=missing'
		};
		const csv = toCsv([{ site, verdict } as never]);
		const body = csv.split('\r\n')[1] as string;
		for (const cell of firstCharsOf(body)) expect(cell).not.toMatch(FORMULA_START);
	});
});
