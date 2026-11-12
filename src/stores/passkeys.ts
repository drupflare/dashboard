import {
	startRegistration,
	type PublicKeyCredentialCreationOptionsJSON
} from '@simplewebauthn/browser';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';

export interface Passkey {
	id: string;
	name: string;
	deviceType: 'singleDevice' | 'multiDevice';
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string | null;
}

export const usePasskeysStore = defineStore('passkeys', {
	state: () => ({
		// undefined: not loaded; an array: loaded, empty when the person has no passkeys
		items: undefined as Passkey[] | undefined,
		error: null as ApiClientError | null
	}),
	actions: {
		async load(): Promise<void> {
			try {
				const { items } = await useApi().get<{ items: Passkey[] }>('/me/passkeys');
				this.items = items;
				this.error = null;
			} catch (cause) {
				this.error = toApiClientError(cause);
			}
		},
		// the server needs a fresh sign-in for both calls; the caller handles a step-up refusal
		async register(name: string): Promise<void> {
			const { options } = await useApi().post<{
				options: PublicKeyCredentialCreationOptionsJSON;
			}>('/me/passkeys/register', { phase: 'options' });
			const response = await startRegistration({ optionsJSON: options });
			await useApi().post('/me/passkeys/register', {
				phase: 'verify',
				response,
				name: name.trim() || undefined
			});
			await this.load();
		},
		async rename(id: string, name: string): Promise<void> {
			const trimmed = name.trim();
			await useApi().patch(`/me/passkeys/${encodeURIComponent(id)}`, { name: trimmed });
			this.items = this.items?.map((passkey) =>
				passkey.id === id ? { ...passkey, name: trimmed } : passkey
			);
		},
		async remove(id: string): Promise<void> {
			await useApi().delete(`/me/passkeys/${encodeURIComponent(id)}`);
			this.items = this.items?.filter((passkey) => passkey.id !== id);
		}
	}
});
