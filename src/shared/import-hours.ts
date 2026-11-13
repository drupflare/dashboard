export const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface HourCap {
	perMonthHours: number;
	perDayHours: number;
}

// 'approval' plans import only after a Drupflare approval step; the app has none yet, so a start is refused
export type ImportCap = HourCap | 'approval';

export interface ImportRun {
	startedAt: number;
	// null until the run closes; an open run is counted as a whole job
	wallMs: number | null;
}

export const IMPORT_RUN_SQL = {
	begin: `INSERT INTO import_runs (operation_id, organization_id, started_at) VALUES (?, ?, ?)
					ON CONFLICT (operation_id) DO NOTHING`,
	started: 'SELECT started_at FROM import_runs WHERE operation_id = ?',
	end: `UPDATE import_runs SET ended_at = ?, wall_ms = MAX(0, ? - started_at)
				WHERE operation_id = ? AND ended_at IS NULL`,
	since: `SELECT started_at, wall_ms FROM import_runs WHERE organization_id = ? AND started_at >= ?`
} as const;

// UTC, so a day and a month start at the same instant for every server
export function utcDayStart(now: number): number {
	return Math.floor(now / DAY_MS) * DAY_MS;
}

export function utcMonthStart(now: number): number {
	const at = new Date(now);
	return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export function wallMsOf(run: ImportRun, jobMs: number): number {
	return run.wallMs ?? jobMs;
}

export function hoursUsedSince(runs: readonly ImportRun[], since: number, jobMs: number): number {
	let total = 0;
	for (const run of runs) {
		if (run.startedAt >= since) total += wallMsOf(run, jobMs);
	}
	return total;
}

export type HoursRefusal =
	'import_hours_today' | 'import_hours_this_month' | 'import_approval_needed';

// a job may run to its whole limit, so a start is admitted only when that much room is left
export function admitHours(
	runs: readonly ImportRun[],
	cap: ImportCap,
	now: number,
	jobMs: number
): HoursRefusal | null {
	if (cap === 'approval') return 'import_approval_needed';
	const day = hoursUsedSince(runs, utcDayStart(now), jobMs);
	if (day + jobMs > cap.perDayHours * HOUR_MS) return 'import_hours_today';
	const month = hoursUsedSince(runs, utcMonthStart(now), jobMs);
	if (month + jobMs > cap.perMonthHours * HOUR_MS) return 'import_hours_this_month';
	return null;
}
