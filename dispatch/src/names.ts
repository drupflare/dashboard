import { DurableObject } from 'cloudflare:workers';
import {
	releaseIn,
	reserveIn,
	tombstoneIn,
	type ReleaseAnswer,
	type ReserveAnswer
} from './registry';

export class Names extends DurableObject {
	reserve(name: string, siteId: string): ReserveAnswer {
		return reserveIn(this.ctx.storage.kv, name, siteId, Date.now(), this.ctx.id.name);
	}

	release(name: string, siteId: string, holdMs?: number): ReleaseAnswer {
		return releaseIn(this.ctx.storage.kv, name, siteId, Date.now(), holdMs);
	}

	tombstone(name: string, siteId: string): ReleaseAnswer {
		return tombstoneIn(this.ctx.storage.kv, name, siteId);
	}
}
