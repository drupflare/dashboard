import { DurableObject } from 'cloudflare:workers';
import {
	applyIn,
	readHourIn,
	type ApplyAnswer,
	type CountedHour,
	type CounterStats,
	type CountWrite
} from './counting';
import type { SyncKv } from './storage';

export class UsageCounter extends DurableObject {
	// kept in memory, so an evicted object starts again from `since`
	private readonly stats: CounterStats = {
		since: Date.now(),
		calls: 0,
		refused: 0,
		puts: 0,
		appliedViews: 0,
		duplicateViews: 0
	};

	private store(): SyncKv {
		const kv = this.ctx.storage.kv;
		return {
			get: <T>(key: string) => kv.get<T>(key),
			put: (key, value) => {
				this.stats.puts++;
				kv.put(key, value);
			}
		};
	}

	apply(write: CountWrite): ApplyAnswer {
		this.stats.calls++;
		const answer = applyIn(this.store(), write, Date.now(), this.ctx.id.name);
		if (answer.ok) {
			this.stats.appliedViews += answer.applied;
			this.stats.duplicateViews += answer.duplicate;
		} else this.stats.refused++;
		return answer;
	}

	read(hour: number): CountedHour | null {
		return readHourIn(this.store(), this.ctx.id.name ?? '', hour);
	}

	counts(): CounterStats {
		return { ...this.stats };
	}
}
