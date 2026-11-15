import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { CorpusResult, CorpusSearch } from '~/shared/corpus';

export type CorpusList = { rows: string[]; items: CorpusResult[] };

export const corpusKey = (orgId: string, search: CorpusSearch): string =>
	`${orgId}|${search.q ?? ''}|${search.status ?? ''}`;

export const useCorpusStore = defineStore('corpus', {
	state: () => ({
		// keyed by organization, search text and status; undefined: not loaded; null: the organization is not found
		lists: new Map<string, CorpusList | null>(),
		error: null as ApiClientError | null
	}),
	actions: {
		async load(orgId: string, search: CorpusSearch = {}): Promise<void> {
			const key = corpusKey(orgId, search);
			if (this.lists.has(key)) return;
			this.error = null;
			const query: Record<string, string> = {};
			if (search.q) query.q = search.q;
			if (search.status) query.status = search.status;
			try {
				const list = await useApi().get<CorpusList>(
					`/orgs/${encodeURIComponent(orgId)}/corpus`,
					query
				);
				this.lists.set(key, list);
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) this.lists.set(key, null);
				else this.error = failure;
			}
		},
		async reload(orgId: string, search: CorpusSearch = {}): Promise<void> {
			this.lists.delete(corpusKey(orgId, search));
			await this.load(orgId, search);
		}
	}
});
