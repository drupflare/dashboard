import { defineStore } from 'pinia';
import { toApiClientError, useApi } from '~/composables/useApi';
import type {
	AssessmentView,
	CheckView,
	ProofCheck,
	ProofView,
	RowView
} from '~/shared/estate-view';
import { useSessionStore } from '~/stores/session';

export interface AssessmentPage {
	items: AssessmentView[];
	nextCursor: string | null;
}

export interface RowQuery {
	cursor?: string;
	class?: string;
	state?: string;
	q?: string;
}

export interface RowPage {
	items: RowView[];
	nextCursor: string | null;
}

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/assessments`;

export const useEstateStore = defineStore('estate', {
	state: () => ({
		// keyed by assessment id; undefined: not loaded; null: known absent; an object: loaded
		assessments: new Map<string, AssessmentView | null>()
	}),
	actions: {
		check(orgId: string, text: string): Promise<CheckView> {
			return useApi().post<CheckView>(`${base(orgId)}/check`, { text });
		},
		// every listed assessment is cached, so a later read of it needs no request
		async list(orgId: string, cursor?: string): Promise<AssessmentPage> {
			const page = await useApi().get<AssessmentPage>(
				base(orgId),
				cursor === undefined ? undefined : { cursor }
			);
			for (const view of page.items) this.assessments.set(view.id, view);
			return page;
		},
		startProof(orgId: string, domain: string): Promise<ProofView> {
			return useApi().post<ProofView>(`${base(orgId)}/proofs`, { domain });
		},
		checkProof(orgId: string, domain: string, method: 'dns' | 'http'): Promise<ProofCheck> {
			return useApi().post<ProofCheck>(`${base(orgId)}/proofs/check`, { domain, method });
		},
		async start(
			orgId: string,
			body: { text: string; credentialIds?: string[] },
			idempotencyKey: string
		): Promise<AssessmentView> {
			const view = await useApi().post<AssessmentView>(base(orgId), body, {
				'Idempotency-Key': idempotencyKey
			});
			this.assessments.set(view.id, view);
			return view;
		},
		// a read that finds nothing is recorded as known absent, so the page can say so without asking again
		async read(orgId: string, id: string): Promise<AssessmentView | null> {
			try {
				const view = await useApi().get<AssessmentView>(
					`${base(orgId)}/${encodeURIComponent(id)}`
				);
				this.assessments.set(id, view);
				return view;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.assessments.set(id, null);
					return null;
				}
				throw failure;
			}
		},
		readRows(orgId: string, id: string, query: RowQuery = {}): Promise<RowPage> {
			const params = Object.fromEntries(
				Object.entries(query).filter((entry): entry is [string, string] => !!entry[1])
			);
			return useApi().get<RowPage>(`${base(orgId)}/${encodeURIComponent(id)}/rows`, params);
		},
		async cancel(orgId: string, id: string): Promise<AssessmentView> {
			const view = await useApi().post<AssessmentView>(
				`${base(orgId)}/${encodeURIComponent(id)}/cancel`
			);
			this.assessments.set(id, view);
			return view;
		},
		// the default parse keeps the JSON error envelope readable for toApiClientError
		async exportCsv(orgId: string, id: string): Promise<string> {
			const fetcher = $fetch as unknown as (
				url: string,
				options: { method: 'GET' }
			) => Promise<string>;
			try {
				return await fetcher(`/api/v1${base(orgId)}/${encodeURIComponent(id)}/export`, {
					method: 'GET'
				});
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 401) useSessionStore().clear();
				throw failure;
			}
		},
		reset(): void {
			this.assessments.clear();
		}
	}
});
