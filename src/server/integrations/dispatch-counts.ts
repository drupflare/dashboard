import { signCounts, type CountsAnswer } from '../../../dispatch/src/control-counts';
import type { CountsReader } from '../services/budget-enforcement';
import type { HoursReader } from '../services/usage-collect';

export interface DispatchCountsConfig {
	// the dispatch Worker's control host, such as https://control.drupflare.com
	controlUrl: string;
	signingKey: CryptoKey;
	now(): number;
	fetch(url: string, init: RequestInit): Promise<Response>;
}

async function postCounts(
	config: DispatchCountsConfig,
	body: { siteId: string; hours: number[]; months: string[] }
): Promise<CountsAnswer | null> {
	const message = await signCounts(body, config.now(), config.signingKey);
	let response: Response;
	try {
		response = await config.fetch(`${config.controlUrl}/counts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(message)
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const answer = (await response.json().catch(() => null)) as CountsAnswer | null;
	return answer?.ok === true ? answer : null;
}

// month-to-date views from the site's counter object, asked through the signed counts read; a
// failed or refused read is null, never zero, so a block is never lifted on a missing answer
export function dispatchCountsReader(config: DispatchCountsConfig): CountsReader {
	return {
		async monthViews(siteId, period) {
			const answer = await postCounts(config, { siteId, hours: [], months: [period] });
			const row = answer?.months.find((m) => m.month === period);
			return row === undefined ? null : row.views;
		}
	};
}

// the hours a site's counter holds; an entry is null for an hour with no record
export function dispatchHoursReader(config: DispatchCountsConfig): HoursReader {
	return {
		async read(siteId, hours) {
			const answer = await postCounts(config, { siteId, hours: [...hours], months: [] });
			return answer === null ? null : answer.hours;
		}
	};
}
