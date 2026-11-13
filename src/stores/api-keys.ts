import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { KeyCreateBody, KeyCreated, KeyPage, KeyView } from '~/shared/api-keys';

export interface KeyList {
	items: KeyView[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const keysPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/api-keys`;

export const useApiKeysStore = defineStore('api-keys', {
	state: () => ({
		// keyed by org id; undefined: not loaded; null: no such organization; an object: loaded
		lists: new Map<string, KeyList | null>()
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
			this.lists.set(orgId, { items: [], nextCursor: null, status: 'loading', error: null });
			await this.fetchPage(orgId, null);
		},
		async reload(orgId: string): Promise<void> {
			this.lists.delete(orgId);
			await this.load(orgId);
		},
		async loadMore(orgId: string): Promise<void> {
			const list = this.lists.get(orgId);
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchPage(orgId, list.nextCursor);
		},
		async fetchPage(orgId: string, cursor: string | null): Promise<void> {
			try {
				const page = await useApi().get<KeyPage>(
					keysPath(orgId),
					cursor ? { cursor } : undefined
				);
				const list = this.lists.get(orgId);
				if (!list) return;
				list.items.push(...page.items);
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) {
					this.lists.set(orgId, null);
					return;
				}
				const list = this.lists.get(orgId);
				if (!list) return;
				list.status = 'error';
				list.error = failure;
			}
		},
		// the token comes back once and is never kept here
		create(orgId: string, body: KeyCreateBody): Promise<KeyCreated> {
			return useApi().post<KeyCreated>(keysPath(orgId), body);
		},
		async revoke(orgId: string, id: string): Promise<void> {
			const key = await useApi().post<KeyView>(
				`${keysPath(orgId)}/${encodeURIComponent(id)}/revoke`,
				{}
			);
			const list = this.lists.get(orgId);
			const at = list?.items.findIndex((item) => item.id === id) ?? -1;
			if (list && at >= 0) list.items[at] = key;
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
