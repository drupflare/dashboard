import {
	BATCH_MAX_BYTES,
	BATCH_REFUSAL_STATUS,
	BUDGET_PATH,
	COUNTS_PATH,
	secretUsable,
	verifyBatch,
	type BatchKind,
	type BatchRefusal,
	type BudgetBatchAnswer,
	type BudgetResult,
	type BudgetWriteItem,
	type CountsBatchAnswer,
	type CountsReadItem,
	type CountsResult
} from '@contracts/engine-batch';
import { START_HEADERS } from '@contracts/engine-start';
import type { CountsAnswer } from '../../dispatch/src/control-counts';
import type { BudgetStateInput, BudgetWrite } from './adapters/authority';

export * from '@contracts/engine-batch';

export interface ReplayStore {
	// false when the id was already claimed
	claim(id: string, now: number): Promise<boolean>;
}

export interface BatchDeps {
	budgetSecret: string | undefined;
	countsSecret: string | undefined;
	now: number;
	replays: ReplayStore;
	authority: {
		applyBudgetState(siteId: string, input: BudgetStateInput): Promise<BudgetWrite>;
	};
	// the hour records and month totals of one site's counter object; null when the read did not answer
	counts(read: CountsReadItem): Promise<CountsAnswer | null>;
}

export const isBatchPath = (pathname: string): boolean =>
	pathname === BUDGET_PATH || pathname === COUNTS_PATH;

const refuse = (code: BatchRefusal) =>
	Response.json({ ok: false, code }, { status: BATCH_REFUSAL_STATUS[code] });

const encoder = new TextEncoder();

// the dashboard's three-state vocabulary on the wire, the lease's own words inside
const inputOf = (state: 'over-budget' | 'active' | 'plan-grace'): BudgetStateInput['state'] =>
	state === 'active' ? 'ok' : state;

// one chunk of sites per request; a failing site is reported and never stops the others
export async function handleBatch(request: Request, deps: BatchDeps): Promise<Response> {
	const { pathname } = new URL(request.url);
	const kind: BatchKind = pathname === BUDGET_PATH ? 'budget' : 'counts';
	if (Object.values(START_HEADERS).some((name) => request.headers.get(name) === null)) {
		return refuse('unsigned');
	}
	const secret = kind === 'budget' ? deps.budgetSecret : deps.countsSecret;
	if (!secretUsable(secret)) return refuse('unconfigured');
	if (Number(request.headers.get('content-length') ?? 0) > BATCH_MAX_BYTES) {
		return refuse('too_large');
	}
	const body = await request.text();
	if (encoder.encode(body).byteLength > BATCH_MAX_BYTES) return refuse('too_large');
	const verdict = await verifyBatch(kind, request.headers, body, { secret, now: deps.now });
	if (!verdict.ok) return refuse(verdict.code);
	if (request.method !== 'POST') return refuse('wrong_method');
	// claimed only after the signature holds, so unsigned traffic never fills the table
	if (!(await deps.replays.claim(`${kind}:${verdict.id}`, deps.now))) return refuse('replayed');

	if (kind === 'budget') {
		const { writes } = verdict.value as { writes: BudgetWriteItem[] };
		const results = await Promise.all(
			writes.map(async (write): Promise<BudgetResult> => {
				try {
					const done = await deps.authority.applyBudgetState(write.siteId, {
						state: inputOf(write.state),
						blockAtViews: write.blockAtViews
					});
					return 'generation' in done
						? {
								siteId: write.siteId,
								outcome: done.outcome,
								generation: done.generation
							}
						: { siteId: write.siteId, outcome: done.outcome };
				} catch {
					return { siteId: write.siteId, outcome: 'failed' };
				}
			})
		);
		const answer: BudgetBatchAnswer = { ok: true, results };
		return Response.json(answer);
	}
	const { reads } = verdict.value as { reads: CountsReadItem[] };
	const results = await Promise.all(
		reads.map(async (read): Promise<CountsResult> => {
			try {
				const answer = await deps.counts(read);
				return answer === null
					? { siteId: read.siteId, ok: false }
					: { siteId: read.siteId, ok: true, hours: answer.hours, months: answer.months };
			} catch {
				return { siteId: read.siteId, ok: false };
			}
		})
	);
	const answer: CountsBatchAnswer = { ok: true, results };
	return Response.json(answer);
}
