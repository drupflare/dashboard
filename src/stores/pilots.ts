import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { DecisionBody, ObservationBody, PilotBody, PilotView } from '~/shared/pilots';

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/pilots`;

export interface PilotReportView {
	name: string;
	startDate: string;
	sponsor: string | null;
	technicalOwner: string | null;
	decision: string | null;
	decidedAt: string | null;
	successCriteria: string;
	hosting: { baselineSpendCents: number | null; status: 'measured' | 'not measured' };
	drupflare: {
		costCents: null;
		costStatus: 'not measured';
		views: number;
		state: 'exact' | 'estimated' | 'unaccounted';
		continuationCostCents: number | null;
	};
	staff: { baselineHours: number | null; observedMinutes: number; observedEntries: number };
	baseline: {
		latencyMs: number | null;
		restoreMinutes: number | null;
		rollbackMinutes: number | null;
		patchDays: number | null;
	};
	failures: { id: string; at: string; text: string }[];
	unsupported: { id: string; at: string; text: string }[];
	exceptions: { id: string; at: string; text: string }[];
	sites: { id: string; name: string; views: number; state: string }[];
	observations: { id: string; at: string; kind: string; minutes: number | null; text: string }[];
	negativeResults: number;
}

export const usePilotsStore = defineStore('pilots', {
	state: () => ({
		// keyed by org id; undefined: not loaded; an array: loaded (possibly empty)
		lists: new Map<string, PilotView[]>(),
		// keyed by pilot id; null: no such pilot; an object: loaded
		views: new Map<string, PilotView | null>(),
		reports: new Map<string, PilotReportView | null>(),
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	actions: {
		async loadList(orgId: string, force = false): Promise<void> {
			if (this.loading || (!force && this.lists.has(orgId))) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: PilotView[] }>(base(orgId));
				this.lists.set(orgId, items);
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async loadOne(orgId: string, id: string, force = false): Promise<void> {
			if (!force && this.views.has(id)) return;
			this.error = null;
			try {
				this.views.set(id, await useApi().get<PilotView>(`${base(orgId)}/${id}`));
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) this.views.set(id, null);
				else this.error = failure;
			}
		},
		async loadReport(orgId: string, id: string) {
			try {
				const report = await useApi().get<PilotReportView>(`${base(orgId)}/${id}/report`);
				this.reports.set(id, report);
				return report;
			} catch (cause) {
				this.error = toApiClientError(cause);
				this.reports.set(id, null);
				return null;
			}
		},
		async create(orgId: string, body: PilotBody): Promise<PilotView | null> {
			this.saving = true;
			this.saveError = null;
			try {
				const view = await useApi().post<PilotView>(base(orgId), body);
				await this.loadList(orgId, true);
				return view;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return null;
			} finally {
				this.saving = false;
			}
		},
		async edit(orgId: string, id: string, body: Partial<PilotBody>): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				this.views.set(id, await useApi().put<PilotView>(`${base(orgId)}/${id}`, body));
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async setSites(orgId: string, id: string, siteIds: string[]): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				this.views.set(
					id,
					await useApi().put<PilotView>(`${base(orgId)}/${id}/sites`, { siteIds })
				);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async addObservation(orgId: string, id: string, body: ObservationBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				await useApi().post(`${base(orgId)}/${id}/observations`, body);
				await this.loadReport(orgId, id);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async decide(orgId: string, id: string, body: DecisionBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				this.views.set(
					id,
					await useApi().put<PilotView>(`${base(orgId)}/${id}/decision`, body)
				);
				await this.loadReport(orgId, id);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		}
	}
});
