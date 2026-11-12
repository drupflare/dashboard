import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

export const useOperationsStore = defineStore('operations', {
	state: () => ({
		// keyed by operation id; undefined: not loaded; null: known absent; an object: loaded
		byId: new Map<string, Operation | null>()
	}),
	actions: {
		// useApi has no header argument; a retry already open comes back, so a fresh key is safe
		async retry(orgId: string, id: string): Promise<Operation> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'POST'; headers: Record<string, string> }
			) => Promise<Operation>;
			try {
				const operation = await fetcher(
					`/api/v1/orgs/${encodeURIComponent(orgId)}/operations/${encodeURIComponent(id)}/retry`,
					{ method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } }
				);
				this.byId.set(operation.id, operation);
				return operation;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		async fetchOne(orgId: string, id: string): Promise<Operation | null> {
			try {
				const operation = await useApi().get<Operation>(
					`/orgs/${encodeURIComponent(orgId)}/operations/${encodeURIComponent(id)}`
				);
				this.byId.set(id, operation);
				return operation;
			} catch (error) {
				if (toApiClientError(error).status === 404) {
					this.byId.set(id, null);
					return null;
				}
				throw error;
			}
		},
		reset(): void {
			this.byId.clear();
		}
	}
});
