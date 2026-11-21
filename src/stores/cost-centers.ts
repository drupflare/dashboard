import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type {
	AssignSiteBody,
	CostCenterBody,
	CostCenterView,
	CostReport,
	CostSite
} from '~/shared/cost-centers';

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/cost-centers`;

const reportKey = (orgId: string, month: string, amountCents: number | null) =>
	`${orgId}|${month}|${amountCents ?? ''}`;

export const useCostCentersStore = defineStore('cost-centers', {
	state: () => ({
		// keyed by org id; undefined: not loaded; an array: loaded (possibly empty)
		centers: new Map<string, CostCenterView[]>(),
		sites: new Map<string, CostSite[]>(),
		// keyed by org, month and amount; null: the report could not be read
		reports: new Map<string, CostReport | null>(),
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	actions: {
		async loadCenters(orgId: string, force = false): Promise<void> {
			if (this.loading || (!force && this.centers.has(orgId))) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: CostCenterView[] }>(base(orgId));
				this.centers.set(orgId, items);
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async loadSites(orgId: string, force = false): Promise<void> {
			if (!force && this.sites.has(orgId)) return;
			try {
				const { items } = await useApi().get<{ items: CostSite[] }>(`${base(orgId)}/sites`);
				this.sites.set(orgId, items);
			} catch (cause) {
				this.error = toApiClientError(cause);
			}
		},
		async loadReport(orgId: string, month: string, amountCents: number | null = null) {
			const query = new URLSearchParams({ month });
			if (amountCents !== null) query.set('amountCents', String(amountCents));
			try {
				const report = await useApi().get<CostReport>(`${base(orgId)}/report?${query}`);
				this.reports.set(reportKey(orgId, month, amountCents), report);
				return report;
			} catch (cause) {
				this.error = toApiClientError(cause);
				this.reports.set(reportKey(orgId, month, amountCents), null);
				return null;
			}
		},
		reportOf(orgId: string, month: string, amountCents: number | null = null) {
			return this.reports.get(reportKey(orgId, month, amountCents));
		},
		async save(orgId: string, id: string | null, body: CostCenterBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				if (id === null) await useApi().post(base(orgId), body);
				else await useApi().put(`${base(orgId)}/${encodeURIComponent(id)}`, body);
				await this.loadCenters(orgId, true);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async assign(orgId: string, siteId: string, body: AssignSiteBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				await useApi().put(`${base(orgId)}/sites/${encodeURIComponent(siteId)}`, body);
				await this.loadSites(orgId, true);
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
