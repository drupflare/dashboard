import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { AttachStage, DnsRecord } from '~/shared/domain-copy';

export interface AttachView {
	operationId: string;
	hostname: string;
	status: 'running' | 'succeeded' | 'failed';
	stages: {
		id: AttachStage;
		label: string;
		state: 'waiting' | 'pending' | 'done' | 'failed';
		text: string;
	}[];
	records: DnsRecord[];
	checks: number;
	reason: string | null;
	updatedAt: number;
}

export interface DomainPayload {
	ready: boolean;
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
		reset(): void {
			this.bySite.clear();
			this.errors.clear();
		}
	}
});
