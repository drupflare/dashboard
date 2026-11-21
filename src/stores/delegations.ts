import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { DelegationCreate, DelegationList, DelegationView } from '~/shared/agency';

export interface DelegationState {
	data: DelegationList | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const path = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/delegations`;
const one = (orgId: string, id: string) => `${path(orgId)}/${encodeURIComponent(id)}`;

export const useDelegationsStore = defineStore('delegations', {
	state: () => ({
		// keyed by org id; undefined: not loaded; null: no such organization; an object: loaded
		lists: new Map<string, DelegationState | null>()
	}),
	actions: {
		async load(orgId: string): Promise<void> {
			const existing = this.lists.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			await this.fetch(orgId);
		},
		async reload(orgId: string): Promise<void> {
			this.lists.delete(orgId);
			await this.load(orgId);
		},
		async fetch(orgId: string): Promise<void> {
			this.lists.set(orgId, { data: null, status: 'loading', error: null });
			try {
				const data = await useApi().get<DelegationList>(path(orgId));
				this.lists.set(orgId, { data, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) {
					this.lists.set(orgId, null);
					return;
				}
				this.lists.set(orgId, { data: null, status: 'error', error: failure });
			}
		},
		create(orgId: string, body: DelegationCreate): Promise<DelegationView> {
			return useApi().post<DelegationView>(path(orgId), body);
		},
		async accept(orgId: string, id: string): Promise<void> {
			await useApi().post<DelegationView>(`${one(orgId, id)}/accept`, {});
			await this.reload(orgId);
		},
		async revoke(orgId: string, id: string): Promise<void> {
			await useApi().post<DelegationView>(`${one(orgId, id)}/revoke`, {});
			await this.reload(orgId);
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
