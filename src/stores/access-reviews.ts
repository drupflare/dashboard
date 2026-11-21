import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type {
	CloseResult,
	EvidenceJson,
	ReviewCreateBody,
	ReviewDecideBody,
	ReviewDetail,
	ReviewItemView,
	ReviewList,
	ReviewScheduleView,
	ReviewView,
	StaleReport
} from '~/shared/access-reviews';
import type { OrgSettings } from '~/shared/org-settings';

type Status = 'loading' | 'ready' | 'error';

export interface ReviewLoad<T> {
	data: T;
	status: Status;
	error: ApiClientError | null;
}

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/reviews`;
const one = (orgId: string, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`;

const failed = <T>(data: T, cause: unknown): ReviewLoad<T> | null => {
	const error = toApiClientError(cause);
	return error.status === 404 ? null : { data, status: 'error', error };
};

// every map is keyed by organization id (a review by organization and review id); undefined: not
// loaded; null: not there; an object: loaded
export const useAccessReviewsStore = defineStore('access-reviews', {
	state: () => ({
		lists: new Map<string, ReviewLoad<ReviewView[]> | null>(),
		details: new Map<string, ReviewLoad<ReviewDetail | null> | null>(),
		stale: new Map<string, ReviewLoad<StaleReport | null> | null>(),
		schedules: new Map<string, ReviewLoad<ReviewScheduleView | null> | null>(),
		settings: new Map<string, ReviewLoad<OrgSettings | null> | null>(),
		evidence: new Map<string, EvidenceJson>()
	}),
	actions: {
		async loadList(orgId: string): Promise<void> {
			const existing = this.lists.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			await this.fetchList(orgId);
		},
		async fetchList(orgId: string): Promise<void> {
			this.lists.set(orgId, { data: [], status: 'loading', error: null });
			try {
				const list = await useApi().get<ReviewList>(base(orgId));
				this.lists.set(orgId, { data: list.items, status: 'ready', error: null });
			} catch (cause) {
				this.lists.set(orgId, failed<ReviewView[]>([], cause));
			}
		},
		async create(orgId: string, body: ReviewCreateBody): Promise<ReviewView> {
			const created = await useApi().post<ReviewView>(base(orgId), body);
			await this.fetchList(orgId);
			return created;
		},
		async fetchDetail(orgId: string, id: string): Promise<void> {
			const key = `${orgId}/${id}`;
			this.details.set(key, { data: null, status: 'loading', error: null });
			try {
				const detail = await useApi().get<ReviewDetail>(one(orgId, id));
				this.details.set(key, { data: detail, status: 'ready', error: null });
			} catch (cause) {
				this.details.set(key, failed<ReviewDetail | null>(null, cause));
			}
		},
		async decide(orgId: string, id: string, body: ReviewDecideBody): Promise<ReviewItemView> {
			const item = await useApi().post<ReviewItemView>(`${one(orgId, id)}/decisions`, body);
			await this.fetchDetail(orgId, id);
			return item;
		},
		async close(orgId: string, id: string): Promise<CloseResult> {
			const result = await useApi().post<CloseResult>(`${one(orgId, id)}/close`, {});
			await Promise.all([this.fetchDetail(orgId, id), this.fetchList(orgId)]);
			return result;
		},
		async loadEvidence(orgId: string, id: string): Promise<EvidenceJson> {
			const evidence = await useApi().get<EvidenceJson>(`${one(orgId, id)}/evidence`);
			this.evidence.set(`${orgId}/${id}`, evidence);
			return evidence;
		},
		async loadStale(orgId: string): Promise<void> {
			this.stale.set(orgId, { data: null, status: 'loading', error: null });
			try {
				const report = await useApi().get<StaleReport>(`${base(orgId)}/stale`);
				this.stale.set(orgId, { data: report, status: 'ready', error: null });
			} catch (cause) {
				this.stale.set(orgId, failed<StaleReport | null>(null, cause));
			}
		},
		async loadSchedule(orgId: string): Promise<void> {
			this.schedules.set(orgId, { data: null, status: 'loading', error: null });
			try {
				const schedule = await useApi().get<ReviewScheduleView>(`${base(orgId)}/schedule`);
				this.schedules.set(orgId, { data: schedule, status: 'ready', error: null });
			} catch (cause) {
				this.schedules.set(orgId, failed<ReviewScheduleView | null>(null, cause));
			}
		},
		async loadSettings(orgId: string): Promise<void> {
			if (this.settings.get(orgId) !== undefined) return;
			this.settings.set(orgId, { data: null, status: 'loading', error: null });
			try {
				const settings = await useApi().get<OrgSettings>(
					`/orgs/${encodeURIComponent(orgId)}/settings`
				);
				this.settings.set(orgId, { data: settings, status: 'ready', error: null });
			} catch (cause) {
				this.settings.set(orgId, failed<OrgSettings | null>(null, cause));
			}
		},
		async setSettings(orgId: string, body: OrgSettings): Promise<void> {
			const settings = await useApi().put<OrgSettings>(
				`/orgs/${encodeURIComponent(orgId)}/settings`,
				body
			);
			this.settings.set(orgId, { data: settings, status: 'ready', error: null });
		},
		async setSchedule(orgId: string, interval: ReviewScheduleView['interval']): Promise<void> {
			const schedule = await useApi().put<ReviewScheduleView>(`${base(orgId)}/schedule`, {
				interval
			});
			this.schedules.set(orgId, { data: schedule, status: 'ready', error: null });
		}
	}
});
