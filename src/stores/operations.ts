import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi } from '~/composables/useApi';

export const useOperationsStore = defineStore('operations', {
	state: () => ({
		// keyed by operation id; undefined: not loaded; null: known absent; an object: loaded
		byId: new Map<string, Operation | null>()
	}),
	actions: {
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
