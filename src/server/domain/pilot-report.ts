import type { AccountingState } from '../../shared/cost-centers';
import type { ObservationKind, PilotDecision, PilotView } from '../../shared/pilots';

export interface PilotObservation {
	id: string;
	at: string;
	kind: ObservationKind;
	minutes: number | null;
	text: string;
}

export interface PilotReportInput {
	pilot: PilotView;
	sites: { id: string; name: string; views: number; state: AccountingState }[];
	observations: PilotObservation[];
}

export interface PilotReport {
	name: string;
	startDate: string;
	sponsor: string | null;
	technicalOwner: string | null;
	decision: PilotDecision | null;
	decidedAt: string | null;
	// the owner's own words; empty means none were written, and the report says so
	successCriteria: string;
	hosting: { baselineSpendCents: number | null; status: 'measured' | 'not measured' };
	drupflare: {
		costCents: null;
		costStatus: 'not measured';
		views: number;
		state: AccountingState;
		continuationCostCents: number | null;
	};
	staff: {
		baselineHours: number | null;
		observedMinutes: number;
		observedEntries: number;
		entries: PilotObservation[];
	};
	baseline: {
		latencyMs: number | null;
		restoreMinutes: number | null;
		rollbackMinutes: number | null;
		patchDays: number | null;
	};
	failures: PilotObservation[];
	unsupported: PilotObservation[];
	exceptions: PilotObservation[];
	sites: PilotReportInput['sites'];
	observations: PilotObservation[];
	negativeResults: number;
}

const byKind = (observations: PilotObservation[], kind: ObservationKind) =>
	observations.filter((observation) => observation.kind === kind);

// negative results and source rows stay in the report; nothing is dropped to make the outcome read better
export function buildPilotReport(input: PilotReportInput): PilotReport {
	const { pilot, observations } = input;
	const manual = byKind(observations, 'manual-work');
	const failures = byKind(observations, 'failure');
	const unsupported = byKind(observations, 'unsupported');
	const exceptions = byKind(observations, 'exception');
	const views = input.sites.reduce((sum, site) => sum + site.views, 0);
	const state: AccountingState = input.sites.some((site) => site.state === 'unaccounted')
		? 'unaccounted'
		: input.sites.some((site) => site.state === 'estimated')
			? 'estimated'
			: 'exact';
	const spend = pilot.baselineHostingSpendCents;
	return {
		name: pilot.name,
		startDate: pilot.startDate,
		sponsor: pilot.sponsor,
		technicalOwner: pilot.technicalOwner,
		decision: pilot.decision,
		decidedAt: pilot.decidedAt,
		successCriteria: pilot.successCriteria,
		hosting: {
			baselineSpendCents: spend,
			status: spend === null ? 'not measured' : 'measured'
		},
		drupflare: {
			costCents: null,
			costStatus: 'not measured',
			views,
			state,
			continuationCostCents: pilot.continuationCostCents
		},
		staff: {
			baselineHours: pilot.baselineStaffHours,
			observedMinutes: manual.reduce((sum, row) => sum + (row.minutes ?? 0), 0),
			observedEntries: manual.length,
			entries: manual
		},
		baseline: {
			latencyMs: pilot.baselineLatencyMs,
			restoreMinutes: pilot.baselineRestoreMinutes,
			rollbackMinutes: pilot.baselineRollbackMinutes,
			patchDays: pilot.baselinePatchDays
		},
		failures,
		unsupported,
		exceptions,
		sites: input.sites,
		observations,
		negativeResults: failures.length + unsupported.length
	};
}

// one row per observation, every kind, in the order they were recorded
export function reportCsvRows(report: PilotReport): (string | number | null)[][] {
	return [
		['at', 'kind', 'minutes', 'text'],
		...report.observations.map((row) => [row.at, row.kind, row.minutes, row.text])
	];
}
