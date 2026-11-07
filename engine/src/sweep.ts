import { sweepLeaks, type LeakReport } from './ownership';
import type { EngineDeps } from './ports';
import { StepFailed, type StepRunner } from './step';
import { recoverCreate } from './workflows/site-create';

// a failed create has long since stopped by then, and its lease has run out, so a sweep never
// races the run that failed; the lease still decides when a repair holds the site
const MIN_FAILED_AGE_MS = 20 * 60 * 1000;
const BATCH = 10;

export interface RecoveredCreate {
	siteId: string;
	operationId: string;
	outcome: string;
}

export interface SweepReport {
	recovered: RecoveredCreate[];
	leaks: LeakReport | null;
}

// no Workflow behind a sweep, so a step runs once and a failure surfaces as the same StepFailed;
// every action is safe to repeat, and the next sweep repeats whatever failed
const inlineRunner: StepRunner = {
	async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			throw new StepFailed(name, error);
		}
	}
};

interface Scope {
	accountId: string;
	minFailedAgeMs?: number;
}

export async function sweep(deps: EngineDeps, scope: Scope): Promise<SweepReport> {
	const rows = await deps.store.strandedCreates(
		deps.now() - (scope.minFailedAgeMs ?? MIN_FAILED_AGE_MS),
		BATCH
	);
	const recovered: RecoveredCreate[] = [];
	for (const row of rows) {
		let outcome: string;
		try {
			const result = await recoverCreate(inlineRunner, deps, {
				operationId: row.operationId,
				site: {
					id: row.siteId,
					accountId: row.accountId ?? scope.accountId,
					plane: row.plane,
					config: row.config
				},
				hostname: row.hostname ?? ''
			});
			outcome = result.status;
		} catch (error) {
			outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
		}
		recovered.push({ siteId: row.siteId, operationId: row.operationId, outcome });
	}
	// reports and proposes only; nothing here deletes an account resource the ledger does not name
	const leaks = await sweepLeaks(deps.cloudflare, deps.ledger, {
		accountId: scope.accountId,
		plane: 'managed'
	}).catch(() => null);
	return { recovered, leaks };
}

export async function sweepAndLog(deps: EngineDeps, scope: Scope): Promise<SweepReport> {
	const report = await sweep(deps, scope);
	console.log(JSON.stringify({ event: 'engine.sweep', ...report }));
	return report;
}
