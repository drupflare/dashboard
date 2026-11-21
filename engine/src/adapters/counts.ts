import type { CountsAnswer, CountsReader } from '../../../dispatch/src/control-counts';
import { counterFor } from '../../../dispatch/src/usage';

// the id comes from dispatch's counterFor, so a read lands on the object dispatch writes to
export function usageCountsOf(namespace: Parameters<typeof counterFor>[0]) {
	return async (read: {
		siteId: string;
		hours: number[];
		months: string[];
	}): Promise<CountsAnswer> => {
		const counter = counterFor(namespace, read.siteId) as unknown as CountsReader;
		const hours = await Promise.all(read.hours.map((hour) => counter.read(hour)));
		const months = await Promise.all(
			read.months.map(async (month) => ({ month, views: await counter.month(month) }))
		);
		return { ok: true, hours, months };
	};
}
