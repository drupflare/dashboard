import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { NodePage, NodeView, PairingView } from '~/shared/nodes';

export interface NodeList {
	items: NodeView[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const nodesPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/nodes`;

export const useNodesStore = defineStore('nodes', {
	state: () => ({
		// keyed by org id; undefined: not loaded; an object: loaded
		lists: new Map<string, NodeList>()
	}),
	getters: {
		listFor:
			(state) =>
			(orgId: string): NodeList | undefined =>
				state.lists.get(orgId)
	},
	actions: {
		async load(orgId: string): Promise<void> {
			const existing = this.lists.get(orgId);
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
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
				const page = await useApi().get<NodePage>(
					nodesPath(orgId),
					cursor ? { cursor } : undefined
				);
				const list = this.lists.get(orgId);
				if (!list) return;
				list.items.push(...page.items);
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (error) {
				const list = this.lists.get(orgId);
				if (!list) return;
				list.status = 'error';
				list.error = toApiClientError(error);
			}
		},
		// the token comes back once and is never kept here
		pair(orgId: string): Promise<PairingView> {
			return useApi().post<PairingView>(`${nodesPath(orgId)}/pair`, {});
		},
		async revoke(orgId: string, id: string): Promise<void> {
			const node = await useApi().post<NodeView>(
				`${nodesPath(orgId)}/${encodeURIComponent(id)}/revoke`,
				{}
			);
			const list = this.lists.get(orgId);
			const at = list?.items.findIndex((item) => item.id === id) ?? -1;
			if (list && at >= 0) list.items[at] = node;
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
