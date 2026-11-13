import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { AttachStage, DnsRecord } from '~/shared/domain-copy';

export interface AttachView {
	operationId: string;
	hostname: string;
	status: 'running' | 'waiting' | 'succeeded' | 'failed';
	stages: {
		id: AttachStage;
		label: string;
		state: 'waiting' | 'pending' | 'done' | 'failed';
		text: string;
	}[];
	records: DnsRecord[];
	// the plain sentence for a waiting attach; null otherwise
	notice: string | null;
	checks: number;
	reason: string | null;
	// when a running attach stops waiting for the ownership record; null otherwise
	expiresAt: number | null;
	updatedAt: number;
}

export interface RecordCheck extends DnsRecord {
	status: 'ok' | 'missing' | 'wrong' | 'unknown';
	statusText: string;
	found: string[];
}

export interface DomainCheck {
	hostname: string;
	apex: boolean;
	held: boolean;
	routingKnown: boolean;
	records: RecordCheck[];
	hazards: { code: string; text: string }[];
	unknown: boolean;
}

export interface DomainPayload {
	ready: boolean;
	// false while custom domains are switched off for the platform
	enabled: boolean;
	attached: { hostname: string; since: number }[];
	attach: AttachView | null;
}

const base = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/domain`;

export const useDomainStore = defineStore('domain', {
	state: () => ({
		// keyed by site id; undefined: not loaded; null: known absent; an object: loaded
		bySite: new Map<string, DomainPayload | null>(),
		errors: new Map<string, ApiClientError>()
	}),
	actions: {
		async read(orgId: string, siteId: string): Promise<DomainPayload | null> {
			try {
				const payload = await useApi().get<DomainPayload>(base(orgId, siteId));
				this.bySite.set(siteId, payload);
				this.errors.delete(siteId);
				return payload;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.bySite.set(siteId, null);
					this.errors.delete(siteId);
					return null;
				}
				this.errors.set(siteId, failure);
				throw failure;
			}
		},
		async attach(
			orgId: string,
			siteId: string,
			body: { hostname: string },
			idempotencyKey: string
		): Promise<void> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; headers: Record<string, string>; body: object }
			) => Promise<unknown>;
			try {
				await fetcher(`/api/v1${base(orgId, siteId)}`, {
					method: 'POST',
					headers: { 'Idempotency-Key': idempotencyKey },
					body
				});
			} catch (error) {
				throw toApiClientError(error);
			}
			await this.read(orgId, siteId);
		},
		// reads every record live and starts nothing, so it can run as often as the owner wants
		async check(orgId: string, siteId: string, hostname: string): Promise<DomainCheck> {
			try {
				return await useApi().post<DomainCheck>(`${base(orgId, siteId)}/check`, {
					hostname
				});
			} catch (error) {
				throw toApiClientError(error);
			}
		},
		// gives up a name that is still waiting, then reads the page state again
		async release(orgId: string, siteId: string, hostname: string): Promise<void> {
			try {
				await useApi().post(`${base(orgId, siteId)}/release`, { hostname });
			} catch (error) {
				throw toApiClientError(error);
			}
			await this.read(orgId, siteId);
		},
		reset(): void {
			this.bySite.clear();
			this.errors.clear();
		}
	}
});
