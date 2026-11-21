import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { TrustDocumentView, TrustUpload } from '~/shared/trust';

export const useTrustStore = defineStore('trust', {
	state: () => ({
		// undefined: not loaded; an array: loaded (possibly empty)
		published: undefined as TrustDocumentView[] | undefined,
		documents: undefined as TrustDocumentView[] | undefined,
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	actions: {
		async loadPublished(force = false): Promise<void> {
			if (this.loading || (!force && this.published !== undefined)) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: TrustDocumentView[] }>(
					'/trust/documents'
				);
				this.published = items;
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async loadAll(force = false): Promise<void> {
			if (this.loading || (!force && this.documents !== undefined)) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: TrustDocumentView[] }>(
					'/admin/trust/documents'
				);
				this.documents = items;
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async upload(body: TrustUpload): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				await useApi().post('/admin/trust/documents', body);
				await this.loadAll(true);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async act(id: string, step: 'publish' | 'retire'): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				await useApi().post(`/admin/trust/documents/${encodeURIComponent(id)}/${step}`, {});
				await this.loadAll(true);
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
