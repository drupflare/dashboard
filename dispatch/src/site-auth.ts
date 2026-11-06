import { fromBase64Url, signingKeyFromSeed, type SigningKey } from '@contracts/common';
import type { AuthorityState } from '@contracts/site-auth';
import { DurableObject } from 'cloudflare:workers';
import {
	applyTo,
	leaseFor,
	readAuthority,
	renewFor,
	type ApplyResult,
	type SiteAuthResult
} from './authority';

export type SiteAuthEnv = {
	SITE_AUTH_SEED: string;
	CONTROL_PUBLIC_KEY: string;
};

export class SiteAuth extends DurableObject<SiteAuthEnv> {
	private key?: Promise<SigningKey>;

	private signingKey(): Promise<SigningKey> {
		this.key ??= signingKeyFromSeed(fromBase64Url(this.env.SITE_AUTH_SEED));
		return this.key;
	}

	read(): AuthorityState | null {
		return readAuthority(this.ctx.storage.kv) ?? null;
	}

	async lease(request: { siteId: string; epoch: number }): Promise<SiteAuthResult> {
		const now = Date.now();
		const { privateKey } = await this.signingKey();
		return leaseFor(this.ctx.storage.kv, request, now, privateKey);
	}

	async renew(request: unknown): Promise<SiteAuthResult> {
		const now = Date.now();
		const { privateKey } = await this.signingKey();
		return renewFor(this.ctx.storage.kv, request, now, privateKey);
	}

	async apply(message: unknown): Promise<ApplyResult> {
		return applyTo(this.ctx.storage.kv, message, {
			controlKey: this.env.CONTROL_PUBLIC_KEY,
			now: Date.now(),
			expectedSiteId: this.ctx.id.name
		});
	}
}
