import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ProcurementBody, ProcurementView } from '~/shared/procurement';

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/procurement`;

export const useProcurementStore = defineStore('procurement', {
	state: () => ({
		// keyed by org id; undefined: not loaded; an array: loaded (possibly empty)
		records: new Map<string, ProcurementView[]>(),
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	actions: {
		async load(orgId: string, force = false): Promise<void> {
			if (this.loading || (!force && this.records.has(orgId))) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: ProcurementView[] }>(base(orgId));
				this.records.set(orgId, items);
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async save(orgId: string, id: string | null, body: ProcurementBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				if (id === null) await useApi().post(base(orgId), body);
				else await useApi().put(`${base(orgId)}/${encodeURIComponent(id)}`, body);
				await this.load(orgId, true);
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
