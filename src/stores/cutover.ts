import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { CutoverChoiceName, CutoverPolicyName } from '~/shared/cutover-copy';

export interface CutoverView {
	operationId: string;
	siteId: string;
	policy: CutoverPolicyName;
	state:
		| 'planned'
		| 'running'
		| 'awaiting-approval'
		| 'promoted'
		| 'observing'
		| 'completed'
		| 'rolled-back'
		| 'failed';
	step: string | null;
	expectedWindowSeconds: number | null;
	destinationWrites: number;
	choice: { value: CutoverChoiceName; writesAtChoice: number; recordedAt: string } | null;
	boundary: 'dns-reversal' | 'post-write';
	needsChoice: boolean;
	observed: number;
	lastHealthy: boolean | null;
	exportReference: string | null;
	finalChanges: 'waiting' | 'ready' | 'none' | 'unread' | null;
	finalStatements: number;
	cannotCarry: string[];
	refusal: { code: string; message: string } | null;
	reason: string | null;
	sourceDestroyed: false;
	updatedAt: string | null;
	steps: {
		id: string;
		name: string;
		state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
	}[];
}

export interface CutoverPayload {
	ready: boolean;
	available: boolean;
	policies: { policy: CutoverPolicyName; expectedWindowSeconds: number }[];
	observationOffsetsMs: number[];
	ttlSeconds: number;
	cutover: CutoverView | null;
}

const base = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/cutover`;

export const useCutoverStore = defineStore('cutover', {
	state: () => ({
		// keyed by site id; undefined: not loaded; null: known absent; an object: loaded
		bySite: new Map<string, CutoverPayload | null>(),
		errors: new Map<string, ApiClientError>()
	}),
	actions: {
		async read(orgId: string, siteId: string): Promise<CutoverPayload | null> {
			try {
				const plan = await useApi().get<CutoverPayload>(base(orgId, siteId));
				this.bySite.set(siteId, plan);
				this.errors.delete(siteId);
				return plan;
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
		async start(
			orgId: string,
			siteId: string,
			body: { policy: CutoverPolicyName; source: { ref: string }; hostname: string },
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
		async approve(orgId: string, siteId: string): Promise<void> {
			await useApi().post(`${base(orgId, siteId)}/approve`);
			await this.read(orgId, siteId);
		},
		async choose(
			orgId: string,
			siteId: string,
			value: CutoverChoiceName | 'rollback'
		): Promise<void> {
			await useApi().post(`${base(orgId, siteId)}/choice`, { value });
			await this.read(orgId, siteId);
		},
		reset(): void {
			this.bySite.clear();
			this.errors.clear();
		}
	}
});
