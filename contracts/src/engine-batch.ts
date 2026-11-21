import { z } from 'zod';
import {
	MAX_START_BYTES,
	secretUsable,
	signRequest,
	verifySigned,
	type StartRefusal
} from './engine-start';

// two message types, each with its own context, secret and path: a counts read can never be
// replayed as a budget write, and the secret that reads counts cannot sign a write
export const BUDGET_PATH = '/budget';
export const COUNTS_PATH = '/counts';
export const BUDGET_CONTEXT = 'drupflare.engine.budget.v1';
export const COUNTS_CONTEXT = 'drupflare.engine.counts.v1';

// the time and the id are part of what is signed; a captured request is good for this long, once
export const BATCH_WINDOW_MS = 60_000;
export const BATCH_MAX_SITES = 25;
export const BATCH_MAX_BYTES = 65_536;
export const BATCH_MAX_HOURS = 48;
export const BATCH_MAX_MONTHS = 3;

export { secretUsable };

export const BATCH_REFUSALS = [
	'unsigned',
	'malformed',
	'stale',
	'bad_signature',
	'too_large',
	'too_many',
	'wrong_method',
	'replayed',
	'unconfigured'
] as const;
export type BatchRefusal = (typeof BATCH_REFUSALS)[number];

export const BATCH_REFUSAL_STATUS: Record<BatchRefusal, number> = {
	unsigned: 401,
	malformed: 400,
	stale: 401,
	bad_signature: 401,
	too_large: 413,
	too_many: 413,
	wrong_method: 405,
	replayed: 409,
	unconfigured: 500
};

// only these three states can be written, so no budget message can suspend or revoke a site
export const BUDGET_WRITE_STATES = ['over-budget', 'active', 'plan-grace'] as const;
export type BudgetWriteState = (typeof BUDGET_WRITE_STATES)[number];

const siteId = z.string().min(1).max(64);

export const budgetWriteSchema = z
	.object({
		siteId,
		state: z.enum(BUDGET_WRITE_STATES),
		blockAtViews: z.int().nonnegative().nullable()
	})
	.strict();
export type BudgetWriteItem = z.infer<typeof budgetWriteSchema>;

export const budgetBatchSchema = z.object({ writes: z.array(budgetWriteSchema).min(1) }).strict();

export const countsReadSchema = z
	.object({
		siteId,
		hours: z.array(z.int().nonnegative()).max(BATCH_MAX_HOURS),
		months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(BATCH_MAX_MONTHS)
	})
	.strict();
export type CountsReadItem = z.infer<typeof countsReadSchema>;

export const countsBatchSchema = z.object({ reads: z.array(countsReadSchema).min(1) }).strict();

export const BUDGET_OUTCOMES = [
	'written',
	'unchanged',
	'security-state',
	'unknown-site',
	'failed'
] as const;
export type BudgetOutcome = (typeof BUDGET_OUTCOMES)[number];

export type BudgetResult = { siteId: string; outcome: BudgetOutcome; generation?: number };
export type BudgetBatchAnswer = { ok: true; results: BudgetResult[] };

// the counter's hour records pass through untouched; the dashboard reads them as the counter's type
export type CountsResult =
	| { siteId: string; ok: true; hours: unknown[]; months: { month: string; views: number }[] }
	| { siteId: string; ok: false };
export type CountsBatchAnswer = { ok: true; results: CountsResult[] };

export type BatchKind = 'budget' | 'counts';

const CONTEXT: Record<BatchKind, string> = { budget: BUDGET_CONTEXT, counts: COUNTS_CONTEXT };

export const batchPathOf = (kind: BatchKind) => (kind === 'budget' ? BUDGET_PATH : COUNTS_PATH);

// an unset message secret falls back to the start secret; the two contexts still keep the message types apart
export function batchSecretsOf(env: { budget?: unknown; counts?: unknown; start?: unknown }): {
	budgetSecret: string | undefined;
	countsSecret: string | undefined;
} {
	const set = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
	const start = set(env.start);
	return { budgetSecret: set(env.budget) ?? start, countsSecret: set(env.counts) ?? start };
}

export const signBatch = (
	kind: BatchKind,
	body: string,
	options: { secret: string; now: number; id: string }
) => signRequest(CONTEXT[kind], body, options);

export type BatchVerdict<T> =
	{ ok: true; id: string; value: T } | { ok: false; code: BatchRefusal };

const LISTS = { budget: 'writes', counts: 'reads' } as const;

// checks the signature and time before it reads the body as anything but bytes, then the shape
export async function verifyBatch<K extends BatchKind>(
	kind: K,
	headers: { get(name: string): string | null },
	body: string,
	options: { secret: string; now: number }
): Promise<
	BatchVerdict<
		K extends 'budget' ? z.infer<typeof budgetBatchSchema> : z.infer<typeof countsBatchSchema>
	>
> {
	if (new TextEncoder().encode(body).byteLength > Math.min(BATCH_MAX_BYTES, MAX_START_BYTES)) {
		return { ok: false, code: 'too_large' };
	}
	const verdict = await verifySigned(CONTEXT[kind], headers, body, {
		...options,
		windowMs: BATCH_WINDOW_MS
	});
	if (!verdict.ok) return { ok: false, code: refusalOf(verdict.code) };
	const list = (verdict.json as Record<string, unknown> | null)?.[LISTS[kind]];
	if (Array.isArray(list) && list.length > BATCH_MAX_SITES)
		return { ok: false, code: 'too_many' };
	const parsed = (kind === 'budget' ? budgetBatchSchema : countsBatchSchema).safeParse(
		verdict.json
	);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const items = (parsed.data as Record<string, { siteId: string }[]>)[LISTS[kind]] ?? [];
	// one answer per site, so a repeated id would be two writes racing for one lease
	if (new Set(items.map((item) => item.siteId)).size !== items.length) {
		return { ok: false, code: 'malformed' };
	}
	return { ok: true, id: verdict.id, value: parsed.data as never };
}

const refusalOf = (code: StartRefusal): BatchRefusal =>
	(BATCH_REFUSALS as readonly string[]).includes(code) ? (code as BatchRefusal) : 'malformed';
