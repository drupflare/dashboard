import { shardKey } from '../../../src/shared/names';
import type { Names, ReleaseAnswer, ReserveAnswer } from '../ports';

export interface NamesStub {
	reserve(name: string, siteId: string): Promise<ReserveAnswer>;
	release(name: string, siteId: string, holdMs?: number): Promise<ReleaseAnswer>;
}

// a name always goes to the shard that owns it; reserving again for the same site answers reserved
export function namesOf(shard: (key: string) => NamesStub): Names {
	return {
		reserve: (name, siteId) => shard(shardKey(name)).reserve(name, siteId),
		async confirm(name, siteId) {
			return (await shard(shardKey(name)).reserve(name, siteId)) === 'reserved';
		},
		release: (name, siteId, holdMs) => shard(shardKey(name)).release(name, siteId, holdMs)
	};
}
