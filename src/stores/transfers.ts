import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { TransferCreate, TransferList, TransferView } from '~/shared/agency';

export interface TransferState {
	data: TransferList | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const path = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/transfers`;
const one = (orgId: string, id: string) => `${path(orgId)}/${encodeURIComponent(id)}`;
const sitePath = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/transfers`;

export const useTransfersStore = defineStore('transfers', {
	state: () => ({
		// keyed by org id; undefined: not loaded; null: no such organization; an object: loaded
		lists: new Map<string, TransferState | null>()
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
				const data = await useApi().get<TransferList>(path(orgId));
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
		propose(orgId: string, siteId: string, body: TransferCreate): Promise<TransferView> {
			return useApi().post<TransferView>(sitePath(orgId, siteId), body);
		},
		async cancel(orgId: string, siteId: string, id: string): Promise<void> {
			await useApi().post<TransferView>(
				`${sitePath(orgId, siteId)}/${encodeURIComponent(id)}/cancel`,
				{}
			);
			await this.reload(orgId);
		},
		async accept(orgId: string, id: string): Promise<void> {
			await useApi().post<TransferView>(`${one(orgId, id)}/accept`, {});
			await this.reload(orgId);
		},
		async decline(orgId: string, id: string): Promise<void> {
			await useApi().post<TransferView>(`${one(orgId, id)}/decline`, {});
			await this.reload(orgId);
		},
		async complete(orgId: string, id: string): Promise<void> {
			await useApi().post<TransferView>(`${one(orgId, id)}/complete`, {});
			await this.reload(orgId);
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
