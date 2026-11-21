import type { UsageInterval } from '@contracts/usage';
import { csvCell } from './csv';

export type UsageSample = Pick<
	UsageInterval,
	'siteId' | 'start' | 'accuracy' | 'views' | 'lowerBound'
>;

export interface MonthlyUsage {
	month: string;
	siteId: string;
	views: number;
	lowerBound: number;
	unaccountedHours: number;
}

export const USAGE_CSV_HEADER = ['month', 'site_id', 'views', 'lower_bound', 'unaccounted_hours'];

// the one formula guard for every CSV the dashboard writes
export const csvField: (value: string | number) => string = csvCell;

export function csvLine(fields: readonly (string | number)[]): string {
	return fields.map(csvField).join(',');
}

// one row per site and UTC month; an unaccounted hour adds to its own count and nothing to the views
export function monthlyUsage(samples: readonly UsageSample[]): MonthlyUsage[] {
	const rows = new Map<string, MonthlyUsage>();
	for (const sample of samples) {
		const month = sample.start.slice(0, 7);
		const key = `${month}\u0000${sample.siteId}`;
		const row = rows.get(key) ?? {
			month,
			siteId: sample.siteId,
			views: 0,
			lowerBound: 0,
			unaccountedHours: 0
		};
		row.views += sample.views;
		row.lowerBound += sample.lowerBound;
		if (sample.accuracy === 'unaccounted') row.unaccountedHours += 1;
		rows.set(key, row);
	}
	return [...rows.values()].sort(
		(a, b) => a.month.localeCompare(b.month) || a.siteId.localeCompare(b.siteId)
	);
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// the number of months from `from` through `to`, both included; null when either is not YYYY-MM
export function monthSpan(from: string, to: string): number | null {
	const a = MONTH.exec(from);
	const b = MONTH.exec(to);
	if (!a || !b) return null;
	const months = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2])) + 1;
	return months >= 1 ? months : null;
}

export function nextMonth(month: string): string {
	const [year, part] = month.split('-').map(Number) as [number, number];
	return part === 12 ? `${year + 1}-01` : `${year}-${String(part + 1).padStart(2, '0')}`;
}

export function usageCsv(rows: readonly MonthlyUsage[]): string {
	const lines = [csvLine(USAGE_CSV_HEADER)];
	for (const row of rows) {
		lines.push(
			csvLine([row.month, row.siteId, row.views, row.lowerBound, row.unaccountedHours])
		);
	}
	return `${lines.join('\n')}\n`;
}
