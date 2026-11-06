import type { AuthorityState } from '@contracts/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import type { Authority } from '../ports';
import { PermanentError } from '../step';
import type { Hosts } from './hosts';

export type ApplyAnswer =
	{ ok: true; value: { applied: boolean; generation: number } } | { ok: false; code: string };

export interface SiteAuthStub {
	read(): Promise<AuthorityState | null>;
	apply(message: unknown): Promise<ApplyAnswer>;
}

// the message carries a time, so the step is retried and signs a fresh one
export class AuthorityStale extends Error {
	constructor() {
		super('SITE_AUTH found the message stale');
		this.name = 'AuthorityStale';
	}
}

export function authorityOf(options: {
	siteAuth: (siteId: string) => SiteAuthStub;
	hosts: Hosts;
	controlKey: CryptoKey;
	now: () => number;
}): Authority {
	return {
		read: (siteId) => options.siteAuth(siteId).read(),
		async apply(state) {
			const message = await signApply(state, options.now(), options.controlKey);
			const answer = await options.siteAuth(state.siteId).apply(message);
			if (answer.ok) return answer.value;
			if (answer.code === 'stale_message') throw new AuthorityStale();
			throw new PermanentError(
				`authority_${answer.code}`,
				`SITE_AUTH refused the write: ${answer.code}`
			);
		},
		putHost: options.hosts.put,
		deleteHostIfOwned: options.hosts.deleteIfOwned
	};
}
