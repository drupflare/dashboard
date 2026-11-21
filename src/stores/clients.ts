import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ClientBody, ClientView } from '~/shared/agency';

export interface ClientState {
	items: ClientView[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const path = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/clients`;
const one = (orgId: string, id: string) => `${path(orgId)}/${encodeURIComponent(id)}`;
const siteClient = (orgId: string, siteId: string, id: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/clients/${encodeURIComponent(id)}`;

export const useClientsStore = defineStore('clients', {
	state: () => ({
		// keyed by org id; undefined: not loaded; null: no such organization; an object: loaded
		lists: new Map<string, ClientState | null>()
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
			this.lists.set(orgId, { items: [], status: 'loading', error: null });
			try {
				const page = await useApi().get<{ items: ClientView[] }>(path(orgId));
				this.lists.set(orgId, { items: page.items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) {
					this.lists.set(orgId, null);
					return;
				}
				this.lists.set(orgId, { items: [], status: 'error', error: failure });
			}
		},
		create(orgId: string, body: ClientBody): Promise<ClientView> {
			return useApi().post<ClientView>(path(orgId), body);
		},
		async update(orgId: string, id: string, body: ClientBody): Promise<void> {
			await useApi().put<ClientView>(one(orgId, id), body);
			await this.reload(orgId);
		},
		async remove(orgId: string, id: string): Promise<void> {
			await useApi().delete<{ deleted: true }>(one(orgId, id));
			await this.reload(orgId);
		},
		async addSite(orgId: string, siteId: string, id: string): Promise<void> {
			await useApi().put<ClientView>(siteClient(orgId, siteId, id), {});
			await this.reload(orgId);
		},
		async removeSite(orgId: string, siteId: string, id: string): Promise<void> {
			await useApi().delete<{ deleted: true }>(siteClient(orgId, siteId, id));
			await this.reload(orgId);
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
