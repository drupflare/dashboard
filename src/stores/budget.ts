import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { BudgetBody, BudgetReply, BudgetWriteReply } from '~/shared/budgets';

// undefined: not loaded; null: known absent (the organization or site has no record); a reply: loaded
export const useBudgetStore = defineStore('budget', {
	state: () => ({
		org: new Map<string, BudgetReply | null>(),
		orgError: new Map<string, ApiClientError>(),
		// keyed by site id
		sites: new Map<string, BudgetReply | null>(),
		siteError: new Map<string, ApiClientError>()
	}),
	actions: {
		async loadOrg(orgId: string): Promise<void> {
			if (this.org.has(orgId)) return;
			await this.refreshOrg(orgId);
		},
		async refreshOrg(orgId: string): Promise<void> {
			try {
				const reply = await useApi().get<BudgetReply>(
					`/orgs/${encodeURIComponent(orgId)}/budget`
				);
				this.org.set(orgId, reply);
				this.orgError.delete(orgId);
			} catch (error) {
				this.recordOrgFailure(orgId, error);
			}
		},
		async loadSite(orgId: string, siteId: string): Promise<void> {
			if (this.sites.has(siteId)) return;
			await this.refreshSite(orgId, siteId);
		},
		async refreshSite(orgId: string, siteId: string): Promise<void> {
			try {
				const reply = await useApi().get<BudgetReply>(
					`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/budget`
				);
				this.sites.set(siteId, reply);
				this.siteError.delete(siteId);
			} catch (error) {
				this.recordSiteFailure(siteId, error);
			}
		},
		// a save keeps the last good reply on screen; a failure is thrown to the caller, which shows it
		async saveOrg(orgId: string, body: BudgetBody): Promise<BudgetWriteReply> {
			const reply = await useApi().put<BudgetWriteReply>(
				`/orgs/${encodeURIComponent(orgId)}/budget`,
				body
			);
			this.org.set(orgId, reply);
			return reply;
		},
		async saveSite(orgId: string, siteId: string, body: BudgetBody): Promise<BudgetWriteReply> {
			const reply = await useApi().put<BudgetWriteReply>(
				`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/budget`,
				body
			);
			this.sites.set(siteId, reply);
			return reply;
		},
		recordOrgFailure(orgId: string, error: unknown): void {
			const failure = toApiClientError(error);
			if (failure.status === 404) this.org.set(orgId, null);
			else this.orgError.set(orgId, failure);
		},
		recordSiteFailure(siteId: string, error: unknown): void {
			const failure = toApiClientError(error);
			if (failure.status === 404) this.sites.set(siteId, null);
			else this.siteError.set(siteId, failure);
		},
		reset(): void {
			this.org.clear();
			this.orgError.clear();
			this.sites.clear();
			this.siteError.clear();
		}
	}
});
