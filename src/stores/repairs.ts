import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

export interface RepairView {
	id: string;
	title: string;
	status: 'running' | 'succeeded' | 'failed' | 'refused' | 'undone';
	statusText: string;
	createdAt: string;
	before: string;
	after: string | null;
	canUndo: boolean;
	undoReason: string | null;
	isUndo: boolean;
}

export interface RepairList {
	items: RepairView[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

interface RepairPage {
	items: RepairView[];
	nextCursor: string | null;
}

type PostFetcher = (
	url: string,
	options: { method: 'POST'; headers: Record<string, string> }
) => Promise<Operation>;

const repairsPath = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/repairs`;

const keyOf = (orgId: string, siteId: string) => `${orgId}/${siteId}`;

function failed(error: unknown): ApiClientError {
	const apiError = toApiClientError(error);
	if (apiError.status === 401) useSessionStore().clear();
	return apiError;
}

export const useRepairsStore = defineStore('repairs', {
	state: () => ({
		// keyed by `orgId/siteId`; undefined: not loaded; an object: loaded
		lists: new Map<string, RepairList>()
	}),
	getters: {
		listFor:
			(state) =>
			(orgId: string, siteId: string): RepairList | undefined =>
				state.lists.get(keyOf(orgId, siteId))
	},
	actions: {
		async load(orgId: string, siteId: string): Promise<void> {
			const existing = this.lists.get(keyOf(orgId, siteId));
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
			this.lists.set(keyOf(orgId, siteId), {
				items: [],
				nextCursor: null,
				status: 'loading',
				error: null
			});
			await this.fetchPage(orgId, siteId, null);
		},
		async reload(orgId: string, siteId: string): Promise<void> {
			this.lists.delete(keyOf(orgId, siteId));
			await this.load(orgId, siteId);
		},
		async loadMore(orgId: string, siteId: string): Promise<void> {
			const list = this.lists.get(keyOf(orgId, siteId));
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchPage(orgId, siteId, list.nextCursor);
		},
		async fetchPage(orgId: string, siteId: string, cursor: string | null): Promise<void> {
			const key = keyOf(orgId, siteId);
			try {
				const page = await useApi().get<RepairPage>(
					repairsPath(orgId, siteId),
					cursor ? { cursor } : undefined
				);
				const list = this.lists.get(key);
				if (!list) return;
				list.items.push(...page.items);
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (error) {
				const list = this.lists.get(key);
				if (!list) return;
				list.status = 'error';
				list.error = toApiClientError(error);
			}
		},
		// useApi has no header argument, so the Idempotency-Key call goes through $fetch
		async undo(
			orgId: string,
			siteId: string,
			repairId: string,
			idempotencyKey: string
		): Promise<Operation> {
			const fetcher = $fetch as unknown as PostFetcher;
			try {
				return await fetcher(
					`/api/v1${repairsPath(orgId, siteId)}/${encodeURIComponent(repairId)}/undo`,
					{ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }
				);
			} catch (error) {
				throw failed(error);
			}
		},
		reset(): void {
			this.lists.clear();
		}
	}
});
