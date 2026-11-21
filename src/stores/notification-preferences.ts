import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { PreferencesView, UnsubscribeResult } from '~/shared/notification-preferences';
import type { OptionalCategory } from '~/shared/notifications';

// the one signed-in account is the only key; the server reads the user from the session
const ME = 'me';

export const useNotificationPreferencesStore = defineStore('notification-preferences', {
	state: () => ({
		// undefined: not loaded; null: known absent; an object: loaded
		preferences: new Map<string, PreferencesView | null>(),
		loading: false,
		saving: false,
		error: null as ApiClientError | null,
		saveError: null as ApiClientError | null
	}),
	getters: {
		current: (state): PreferencesView | null | undefined => state.preferences.get(ME)
	},
	actions: {
		async load(force = false): Promise<void> {
			if (this.loading || (!force && this.preferences.has(ME))) return;
			this.loading = true;
			this.error = null;
			try {
				this.preferences.set(ME, await useApi().get<PreferencesView>('/me/notifications'));
			} catch (cause) {
				this.error = toApiClientError(cause);
			} finally {
				this.loading = false;
			}
		},
		async set(category: OptionalCategory, enabled: boolean): Promise<boolean> {
			this.saving = true;
			this.saveError = null;
			try {
				this.preferences.set(
					ME,
					await useApi().put<PreferencesView>('/me/notifications', {
						preferences: { [category]: enabled }
					})
				);
				return true;
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return false;
			} finally {
				this.saving = false;
			}
		},
		async unsubscribe(token: string): Promise<UnsubscribeResult | null> {
			this.saveError = null;
			try {
				return await useApi().post<UnsubscribeResult>(
					`/unsubscribe?token=${encodeURIComponent(token)}`,
					{}
				);
			} catch (cause) {
				this.saveError = toApiClientError(cause);
				return null;
			}
		}
	}
});
