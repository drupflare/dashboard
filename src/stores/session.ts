import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import { useOrgStore } from '~/stores/org';
import { useSitesStore } from '~/stores/sites';

export interface Me {
	id: string;
	email: string;
	displayName: string | null;
	platformRole?: 'admin' | null;
	via: 'session' | 'key';
	stepUpUntil: string | null;
}

// one request at a time; a second caller waits on the first
let pending: Promise<void> | null = null;

export function safeRedirect(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
	return value;
}

export const useSessionStore = defineStore('session', {
	state: () => ({
		// undefined: not loaded; null: signed out; Me: signed in
		me: undefined as Me | null | undefined,
		error: null as ApiClientError | null
	}),
	actions: {
		load(): Promise<void> {
			pending ??= this.fetchMe().finally(() => {
				pending = null;
			});
			return pending;
		},
		async ensure(): Promise<void> {
			if (this.me === undefined) await this.load();
		},
		async fetchMe(): Promise<void> {
			try {
				this.me = await useApi().get<Me>('/me');
				this.error = null;
			} catch (error) {
				const apiError = toApiClientError(error);
				if (apiError.status === 401) {
					this.clear();
					return;
				}
				this.error = apiError;
			}
		},
		clear(): void {
			this.me = null;
			this.error = null;
			useOrgStore().reset();
			useSitesStore().reset();
		},
		async signOut(): Promise<void> {
			try {
				await useApi().post('/auth/logout');
			} catch (error) {
				this.error = toApiClientError(error);
				return;
			}
			this.clear();
		}
	}
});
