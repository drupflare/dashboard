export type Observation = {
	// finding codes the site reports now
	findings: readonly string[];
	// reconcile steps still owed or failed; null when the site gave no report
	owed: number | null;
	// answers the control plane reads for itself, keyed by predicate id
	facts: Readonly<Record<string, boolean>>;
};

export type Predicate = (observation: Observation) => boolean;

export class UnknownPredicateError extends Error {
	constructor(id: string) {
		super(`success predicate ${id} has no evaluator`);
	}
}

const clears =
	(code: string): Predicate =>
	(o) =>
		!o.findings.includes(code);

const reconciled: Predicate = (o) => o.owed === 0;

const fact =
	(id: string): Predicate =>
	(o) =>
		o.facts[id] === true;

// every catalogue row's successPredicate is a key here; an id nobody evaluates is a build failure
export const PREDICATES: Readonly<Record<string, Predicate>> = {
	'render.nonempty': clears('render.empty'),
	'render.size_in_band': clears('render.size_anomaly'),
	'bridge.asyncify_clear': clears('bridge.asyncify_called'),
	'bridge.mask_clear': clears('bridge.mask_leaked'),
	'db.semaphore_clear': clears('db.semaphore_dirty'),
	'migrate.complete': clears('migrate.incomplete'),
	'updb.run_not_halted': clears('updb.halted'),
	'pack.generation_matches': reconciled,
	'memory.highwater_flat': clears('memory.highwater_rising'),
	'memory.trend_flat': clears('memory.trend_rising'),
	'ledger.within_cap': clears('health.ledger_oversized'),
	'budget.image_transforms_under_cap': clears('budget.image_transforms'),
	'budget.rows_written_under_warn': clears('budget.rows_written'),
	'budget.do_requests_under_warn': clears('budget.do_requests'),
	'budget.rows_written_trend_flat': clears('budget.rows_written_trend'),
	'budget.do_requests_trend_flat': clears('budget.do_requests_trend'),
	'cache.purity_clean': clears('cache.anonymous_purity'),
	'cache.header_present': clears('cache.header_missing'),
	'db.txn_closed': clears('db.txn_leaked'),
	'account.restored': clears('account.not_restored'),
	'sql.params_within_limit': clears('sql.params_over_100'),
	'sql.like_within_limit': clears('sql.like_over_50'),
	'config.matches_manifest': clears('config.drift'),
	'reconcile.version_current': reconciled,
	'updb.beat_applied': fact('updb.beat_applied'),
	'cache.stale_paths_cleared': fact('cache.stale_paths_cleared'),
	'fill.gap_closed': fact('fill.gap_closed'),
	'backup.verified': fact('backup.verified'),
	'domain.tls_and_routing_valid': fact('domain.tls_and_routing_valid'),
	'advisories.reviewed': fact('advisories.reviewed'),
	'operation.progressing': fact('operation.progressing'),
	'credential.valid': fact('credential.valid'),
	'archive.notice_delivered': fact('archive.notice_delivered')
};

export function evaluatePredicate(
	id: string,
	observation: Observation,
	registry: Readonly<Record<string, Predicate>> = PREDICATES
): boolean {
	const predicate = registry[id];
	if (!predicate) throw new UnknownPredicateError(id);
	return predicate(observation);
}

// budget pressure other than a projection is the site shedding the meter a rebuild would spend
const sheds = (code: string) => code.startsWith('budget.') && !code.endsWith('_trend');

// the health answer carries no transaction depth or load state, so both come from the findings: a
// transaction open across requests is the leak the site reports as db.txn_leaked
export function factsOfFindings(findings: readonly string[]): {
	transactionDepth: number;
	shedding: boolean;
} {
	return {
		transactionDepth: findings.includes('db.txn_leaked') ? 1 : 0,
		shedding: findings.some(sheds)
	};
}
