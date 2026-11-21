import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROWS_PER_CALL, parsePriceSheet, type PriceSheet } from '../spikes/counting/plan';

export type Label = 'published' | 'measured' | 'derived' | 'assumption';

export type Figure = { value: number; label: Label; source: string };

export type Mechanism = 'write-through' | 'batched' | 'hybrid';

export const MECHANISMS: readonly Mechanism[] = ['write-through', 'batched', 'hybrid'];

export const VIEWS_PER_MILLION = 1_000_000;

// the counting run's trial size; the measured calls below are per one 3,000-view site-trial
export const TRIAL_VIEWS = 3_000;

// counter calls per 3,000 views from the live run, low to high over its two runs (5 sites each):
// batched 84 to 167, hybrid 172 to 205; those arms lost their unflushed tail, so a fixed arm
// sends about the same plus up to one tail call per isolate, to be re-measured live
export const CALLS_PER_TRIAL: Record<Mechanism, { low: number; high: number; label: Label }> = {
	'write-through': { low: TRIAL_VIEWS, high: TRIAL_VIEWS, label: 'derived' },
	batched: { low: 84, high: 167, label: 'measured' },
	hybrid: { low: 172, high: 205, label: 'measured' }
};

export type MechanismCost = {
	mechanism: Mechanism;
	requests: { low: Figure; high: Figure };
	rowsWritten: { low: Figure; high: Figure };
	rowsRead: { low: Figure; high: Figure };
	usd: { low: Figure; high: Figure };
};

const derived = (value: number, source: string): Figure => ({ value, label: 'derived', source });

function atCalls(mechanism: Mechanism, calls: number, sheet: PriceSheet) {
	const requests = (calls / TRIAL_VIEWS) * VIEWS_PER_MILLION;
	const written = requests * ROWS_PER_CALL;
	const read = requests * ROWS_PER_CALL;
	const usd =
		(requests / 1e6) * sheet.doRequests.usdPerMillion +
		(written / 1e6) * sheet.rowsWritten.usdPerMillion +
		(read / 1e6) * sheet.rowsRead.usdPerMillion;
	const run = `${mechanism}: ${calls} calls a ${TRIAL_VIEWS}-view trial`;
	return {
		requests: { value: requests, source: run },
		written: { value: written, source: `${run}, ${ROWS_PER_CALL} rows an applying call` },
		read: { value: read, source: `${run}, ${ROWS_PER_CALL} rows an applying call` },
		usd: {
			value: usd,
			source: `gross list rates, no allowance: ${sheet.doRequests.page}, ${sheet.rowsWritten.page}`
		}
	};
}

// gross list prices for one million counted views, no account allowance applied
export function mechanismCost(mechanism: Mechanism, sheet: PriceSheet): MechanismCost {
	const range = CALLS_PER_TRIAL[mechanism];
	const low = atCalls(mechanism, range.low, sheet);
	const high = atCalls(mechanism, range.high, sheet);
	const calls = (f: { value: number; source: string }): Figure => ({
		value: f.value,
		label: range.label,
		source: f.source
	});
	return {
		mechanism,
		requests: { low: calls(low.requests), high: calls(high.requests) },
		// two rows an applying call is the apply code's reads and writes, an upper bound
		rowsWritten: {
			low: { ...calls(low.written), label: 'assumption' },
			high: { ...calls(high.written), label: 'assumption' }
		},
		rowsRead: {
			low: { ...calls(low.read), label: 'assumption' },
			high: { ...calls(high.read), label: 'assumption' }
		},
		usd: {
			low: derived(low.usd.value, low.usd.source),
			high: derived(high.usd.value, high.usd.source)
		}
	};
}

export const costs = (sheet: PriceSheet): MechanismCost[] =>
	MECHANISMS.map((m) => mechanismCost(m, sheet));

export function loadSheet(path = defaultSheetPath()): PriceSheet {
	const checked = parsePriceSheet(JSON.parse(readFileSync(path, 'utf8')));
	if (!checked.ok) throw new Error(`price sheet ${path}: ${checked.reason}`);
	return checked.sheet;
}

function defaultSheetPath(): string {
	return resolve(fileURLToPath(import.meta.url), '../../spikes/counting/prices.json');
}

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const dollars = (n: number) => `$${n.toFixed(2)}`;
const span = (a: Figure, b: Figure, format: (n: number) => string) =>
	a.value === b.value ? format(a.value) : `${format(a.value)} to ${format(b.value)}`;

export function countingTable(sheet: PriceSheet = loadSheet()): string {
	const rows = costs(sheet).map((c) => [
		c.mechanism,
		`${span(c.requests.low, c.requests.high, count)} (${c.requests.low.label})`,
		`${span(c.rowsWritten.low, c.rowsWritten.high, count)} (${c.rowsWritten.low.label})`,
		`${span(c.rowsRead.low, c.rowsRead.high, count)} (${c.rowsRead.low.label})`,
		`${span(c.usd.low, c.usd.high, dollars)} (${c.usd.low.label})`
	]);
	const head = [
		'Mechanism',
		'DO requests per million views',
		'Rows written',
		'Rows read',
		'Gross USD per million views'
	];
	const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
	return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(countingTable());
}
