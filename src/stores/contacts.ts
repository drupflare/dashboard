import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ContactBody, ContactRole, ContactView, TestResult } from '~/shared/contacts';

const base = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/contacts`;

export const useContactsStore = defineStore('contacts', {
	state: () => ({
		// keyed by org id; undefined: not loaded; an array: loaded (possibly empty)
		contacts: new Map<string, ContactView[]>(),
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	actions: {
		async load(orgId: string, force = false): Promise<void> {
			if (this.loading || (!force && this.contacts.has(orgId))) return;
			this.loading = true;
			this.error = null;
			try {
				const { items } = await useApi().get<{ items: ContactView[] }>(base(orgId));
				this.contacts.set(orgId, items);
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async save(orgId: string, role: ContactRole, body: ContactBody): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				const path =
					role === 'recovery' ? `${base(orgId)}/recovery` : `${base(orgId)}/${role}`;
				await useApi().put(path, body);
				await this.load(orgId, true);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async verify(orgId: string, role: ContactRole): Promise<boolean> {
			this.saveError = null;
			try {
				await useApi().post(`${base(orgId)}/${role}/verify`, {});
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			}
		},
		async test(orgId: string, role: ContactRole): Promise<TestResult | null> {
			this.saveError = null;
			try {
				return await useApi().post<TestResult>(`${base(orgId)}/${role}/test`, {});
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return null;
			}
		},
		async confirm(token: string): Promise<boolean> {
			this.saveError = null;
			try {
				await useApi().post('/contacts/confirm', { token });
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			}
		}
	}
});
