import { hourOf, type ApplyAnswer, type CountWrite } from '../../dispatch/src/counting';

export const PRIME_PREFIX = 'prime:';
export const PRIME_MAX_VIEWS = 1_200_000;

export type PrimeStore = {
	list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
	get(key: string): Promise<string | null>;
	delete(key: string): Promise<void>;
};

export type PrimeDeps = {
	mode: string | undefined;
	store: PrimeStore;
	counter(siteId: string): { apply(write: CountWrite): Promise<ApplyAnswer> };
	now(): number;
};

export type PrimeOutcome = {
	id: string;
	siteId: string | null;
	views: number | null;
	result: 'applied' | 'refused' | 'retry';
	code?: string;
};

// stage only: one synthetic count write per queued key, under an origin id taken from the key so a
// retry after a failed delete counts once; the key goes only when the counter answered
export async function primeStage(deps: PrimeDeps): Promise<PrimeOutcome[]> {
	if (deps.mode !== '1') return [];
	const { keys } = await deps.store.list({ prefix: PRIME_PREFIX });
	const out: PrimeOutcome[] = [];
	for (const { name } of keys) {
		const id = name.slice(PRIME_PREFIX.length);
		const refuse = async (code: string, siteId: string | null, views: number | null) => {
			await deps.store.delete(name);
			out.push({ id, siteId, views, result: 'refused', code });
		};
		let request: { siteId?: unknown; views?: unknown } | null;
		try {
			request = JSON.parse((await deps.store.get(name)) ?? 'null');
		} catch {
			request = null;
		}
		const siteId = typeof request?.siteId === 'string' ? request.siteId : null;
		const views = Number.isInteger(request?.views) ? (request?.views as number) : null;
		if (siteId === null || views === null || views < 1) {
			await refuse('malformed', siteId, views);
			continue;
		}
		if (views > PRIME_MAX_VIEWS) {
			await refuse('too_many_views', siteId, views);
			continue;
		}
		let answer: ApplyAnswer;
		try {
			answer = await deps.counter(siteId).apply({
				siteId,
				hour: hourOf(deps.now()),
				origin: id,
				ranges: [{ from: 1, to: views }],
				issued: views,
				unavailable: false,
				sync: true
			});
		} catch {
			out.push({ id, siteId, views, result: 'retry' });
			continue;
		}
		if (!answer.ok) {
			await refuse(answer.reason, siteId, views);
			continue;
		}
		await deps.store.delete(name);
		out.push({ id, siteId, views, result: 'applied' });
	}
	return out;
}
