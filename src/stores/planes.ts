import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ProbeReport } from '~/shared/cloudflare-probe';

// the token is never kept here; the report is held in memory until the page leaves
export const usePlanesStore = defineStore('planes', {
	state: () => ({
		// undefined: no check has run; a report: the last check's answer
		report: undefined as ProbeReport | undefined,
		probing: false,
		error: null as ApiClientError | null
	}),
	actions: {
		async probe(orgId: string, token: string, accountId?: string): Promise<void> {
			this.probing = true;
			this.error = null;
			try {
				this.report = await useApi().post<ProbeReport>(
					`/orgs/${encodeURIComponent(orgId)}/planes/cloudflare/probe`,
					accountId === undefined ? { token } : { token, accountId }
				);
			} catch (cause) {
				this.report = undefined;
				this.error = toApiClientError(cause);
			} finally {
				this.probing = false;
			}
		},
		clear(): void {
			this.report = undefined;
			this.error = null;
			this.probing = false;
		}
	}
});
