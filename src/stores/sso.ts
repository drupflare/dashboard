import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { SsoConfigBody, SsoTestResult, SsoView } from '~/shared/sso';

const ssoPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/sso`;

export const useSsoStore = defineStore('sso', {
	state: () => ({
		// keyed by org id; undefined: not loaded; null: no such organization; an object: loaded
		views: new Map<string, SsoView | null>(),
		loading: false,
		saving: false,
		testing: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null,
		testResult: null as SsoTestResult | null
	}),
	actions: {
		async load(orgId: string, force = false): Promise<void> {
			if (this.loading || (!force && this.views.has(orgId))) return;
			this.loading = true;
			this.error = null;
			try {
				this.views.set(orgId, await useApi().get<SsoView>(ssoPath(orgId)));
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) this.views.set(orgId, null);
				else this.error = failure;
			} finally {
				this.loading = false;
			}
		},
		async save(orgId: string, body: Omit<SsoConfigBody, 'enabled'> & { enabled: boolean }) {
			this.saving = true;
			this.saveError = null;
			try {
				const view = await useApi().put<SsoView>(ssoPath(orgId), body);
				this.views.set(orgId, view);
				return view;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return null;
			} finally {
				this.saving = false;
			}
		},
		async test(orgId: string): Promise<void> {
			this.testing = true;
			this.testResult = null;
			try {
				this.testResult = await useApi().post<SsoTestResult>(`${ssoPath(orgId)}/test`);
				await this.load(orgId, true);
			} catch (cause) {
				this.testResult = { ok: false, message: toApiClientError(cause).message };
			} finally {
				this.testing = false;
			}
		}
	}
});
