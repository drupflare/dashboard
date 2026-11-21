import { vi } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import type { AuthorityState } from '../../../contracts/src/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import type { CountsAnswer } from '../../../dispatch/src/control-counts';
import { budgetAuthorityOf, type SiteAuthStub } from '../../../engine/src/adapters/authority';
import { handleBatch, type BatchDeps, type ReplayStore } from '../../../engine/src/batch';
import { authorityState } from '../dispatch/fakes';
import { siteAuthObjects } from './doubles';

export const NOW = 1_790_000_000_000;
export const BUDGET_SECRET = 'budget-secret-'.repeat(3);
export const COUNTS_SECRET = 'counts-secret-'.repeat(3);

// the authority object checks the message time against its own clock
export const freezeClock = () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
};

export function memoryReplays(): ReplayStore & { ids: Set<string> } {
	const ids = new Set<string>();
	return {
		ids,
		async claim(id) {
			if (ids.has(id)) return false;
			ids.add(id);
			return true;
		}
	};
}

export async function rig(siteIds: string[]) {
	const control = await generateSigningKey();
	const objects = siteAuthObjects(control);
	const stubs = new Map<string, ReturnType<typeof objects.stub>>();
	for (const siteId of siteIds) {
		const stub = objects.stub(siteId);
		await stub.apply(
			await signApply(
				await authorityState({
					siteId: siteId as AuthorityState['siteId'],
					epoch: 1,
					generation: 1
				}),
				NOW,
				control.privateKey
			)
		);
		stubs.set(siteId, stub);
	}
	const broken = new Set<string>();
	const counted: { siteId: string; hours: number[]; months: string[] }[] = [];
	const countsAnswer = new Map<string, CountsAnswer | null | 'throw'>();
	const replays = memoryReplays();
	const deps: BatchDeps = {
		budgetSecret: BUDGET_SECRET,
		countsSecret: COUNTS_SECRET,
		now: NOW,
		replays,
		authority: budgetAuthorityOf({
			siteAuth: (siteId) => {
				if (broken.has(siteId)) throw new Error('the object is down');
				const stub = stubs.get(siteId) ?? objects.stub(siteId);
				return stub as unknown as SiteAuthStub;
			},
			controlKey: control.privateKey,
			now: () => NOW
		}),
		async counts(read) {
			counted.push(read);
			const answer = countsAnswer.get(read.siteId);
			if (answer === 'throw') throw new Error('the counter is down');
			return answer === undefined
				? {
						ok: true,
						hours: read.hours.map(() => null),
						months: read.months.map((month) => ({ month, views: 7 }))
					}
				: answer;
		}
	};
	return { control, stubs, broken, counted, countsAnswer, replays, deps };
}

// the dashboard's ENGINE binding, answered by the real route; `log` sees every request
export function bindingOf(deps: BatchDeps, log: { path: string; body: unknown }[] = []) {
	return {
		async fetch(input: string | Request, init?: RequestInit) {
			const request = new Request(input, init);
			log.push({
				path: new URL(request.url).pathname,
				body: JSON.parse(await request.clone().text())
			});
			return handleBatch(request, deps);
		}
	};
}
