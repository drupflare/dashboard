import {
	BATCH_MAX_SITES,
	batchPathOf,
	batchSecretsOf,
	secretUsable,
	signBatch,
	type BatchKind,
	type BudgetResult,
	type CountsResult
} from '@contracts/engine-batch';
import type { CountedHour } from '../../../dispatch/src/counting';
import type { AuthorityWriter, BudgetWrite, CountsReader } from '../services/budget-enforcement';
import type { HoursReader } from '../services/usage-collect';
import type { EngineBinding } from './engine';

export interface EngineBatchConfig {
	binding: EngineBinding | undefined;
	// one secret per message type: the one that reads counts cannot sign a write
	budgetSecret: string | undefined;
	countsSecret: string | undefined;
	now(): number;
	newId(): string;
}

const isBinding = (value: unknown): value is EngineBinding =>
	typeof (value as { fetch?: unknown } | undefined)?.fetch === 'function';

export function engineBatchConfigOf(
	env: Record<string, unknown>
): Omit<EngineBatchConfig, 'now' | 'newId'> {
	return {
		binding: isBinding(env.ENGINE) ? env.ENGINE : undefined,
		...batchSecretsOf({
			budget: env.BUDGET_SECRET,
			counts: env.COUNTS_SECRET,
			start: env.START_SECRET
		})
	};
}

export const countsConfigured = (config: Pick<EngineBatchConfig, 'binding' | 'countsSecret'>) =>
	config.binding !== undefined && secretUsable(config.countsSecret);

export const budgetConfigured = (config: Pick<EngineBatchConfig, 'binding' | 'budgetSecret'>) =>
	config.binding !== undefined && secretUsable(config.budgetSecret);

const ATTEMPTS = 2;

const chunksOf = <T>(items: readonly T[]): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += BATCH_MAX_SITES) {
		out.push(items.slice(i, i + BATCH_MAX_SITES));
	}
	return out;
};

// one signed round trip per chunk; a retry signs a fresh id (the engine claims an id first)
async function post<T>(
	config: EngineBatchConfig,
	kind: BatchKind,
	payload: Record<string, unknown>
): Promise<T[] | null> {
	const secret = kind === 'budget' ? config.budgetSecret : config.countsSecret;
	if (config.binding === undefined || !secretUsable(secret)) return null;
	const body = JSON.stringify(payload);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		try {
			const headers = await signBatch(kind, body, {
				secret,
				now: config.now(),
				id: config.newId()
			});
			const response = await config.binding.fetch(`https://engine${batchPathOf(kind)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body
			});
			if (!response.ok) continue;
			const answer = (await response.json().catch(() => null)) as {
				ok?: unknown;
				results?: unknown;
			} | null;
			if (answer?.ok === true && Array.isArray(answer.results)) return answer.results as T[];
		} catch {
			// the next attempt signs a fresh request
		}
	}
	return null;
}

async function readCounts(
	config: EngineBatchConfig,
	reads: { siteId: string; hours: readonly number[]; months: readonly string[] }[]
): Promise<Map<string, CountsResult | null>> {
	const out = new Map<string, CountsResult | null>();
	for (const chunk of chunksOf(reads)) {
		const results = await post<CountsResult>(config, 'counts', { reads: chunk });
		for (const read of chunk) {
			out.set(read.siteId, results?.find((r) => r.siteId === read.siteId) ?? null);
		}
	}
	return out;
}

// the counts the engine reads from the dispatch counter with the control key it alone holds
export function engineCountsReaders(config: EngineBatchConfig): {
	views: CountsReader;
	hours: HoursReader;
} {
	const monthViewsMany: NonNullable<CountsReader['monthViewsMany']> = async (siteIds, period) => {
		const answers = await readCounts(
			config,
			siteIds.map((siteId) => ({ siteId, hours: [], months: [period] }))
		);
		const out = new Map<string, number | null>();
		for (const siteId of siteIds) {
			const answer = answers.get(siteId);
			const month =
				answer?.ok === true ? answer.months.find((m) => m.month === period) : undefined;
			out.set(siteId, month === undefined ? null : month.views);
		}
		return out;
	};
	const readMany = async (
		requests: readonly { siteId: string; hours: readonly number[] }[]
	): Promise<Map<string, (CountedHour | null)[] | null>> => {
		const answers = await readCounts(
			config,
			requests.map(({ siteId, hours }) => ({ siteId, hours, months: [] }))
		);
		const out = new Map<string, (CountedHour | null)[] | null>();
		for (const { siteId } of requests) {
			const answer = answers.get(siteId);
			out.set(siteId, answer?.ok === true ? (answer.hours as (CountedHour | null)[]) : null);
		}
		return out;
	};
	return {
		views: {
			async monthViews(siteId, period) {
				return (await monthViewsMany([siteId], period)).get(siteId) ?? null;
			},
			monthViewsMany
		},
		hours: {
			async read(siteId, hours) {
				return (await readMany([{ siteId, hours }])).get(siteId) ?? null;
			},
			readMany
		}
	};
}

// the engine writes the lease; the dashboard only names each site's state and threshold
export function engineBudgetWriter(config: EngineBatchConfig): AuthorityWriter {
	const applyBudgetStates: NonNullable<AuthorityWriter['applyBudgetStates']> = async (writes) => {
		const out = new Map<string, BudgetWrite | Error>();
		for (const chunk of chunksOf(writes)) {
			const results = await post<BudgetResult>(config, 'budget', {
				writes: chunk.map((write) => ({
					siteId: write.siteId,
					state: write.state === 'ok' ? 'active' : write.state,
					blockAtViews: write.blockAtViews
				}))
			});
			for (const { siteId } of chunk) {
				const result = results?.find((r) => r.siteId === siteId);
				if (result === undefined) {
					out.set(siteId, new Error('the engine did not answer for the site'));
				} else if (result.outcome === 'failed') {
					out.set(siteId, new Error('the engine could not write the site'));
				} else if (result.outcome === 'written' || result.outcome === 'unchanged') {
					out.set(siteId, {
						outcome: result.outcome,
						generation: result.generation ?? 0
					});
				} else {
					out.set(siteId, { outcome: result.outcome });
				}
			}
		}
		return out;
	};
	return {
		async applyBudgetState(siteId, input) {
			const answer = (await applyBudgetStates([{ siteId, ...input }])).get(siteId);
			if (answer === undefined || answer instanceof Error) {
				throw answer ?? new Error('the engine did not answer for the site');
			}
			return answer;
		},
		applyBudgetStates
	};
}
