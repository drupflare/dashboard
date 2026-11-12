import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';

export interface Device {
	id: string;
	device: string;
	ip: string | null;
	createdAt: string;
	lastSeenAt: string;
	current: boolean;
}

interface DeviceList {
	items: Device[];
}

export const useDevicesStore = defineStore('devices', {
	state: () => ({
		// undefined: not loaded; an array: loaded (the server never pages this list)
		items: undefined as Device[] | undefined,
		error: null as ApiClientError | null
	}),
	actions: {
		async load(): Promise<void> {
			try {
				const list = await useApi().get<DeviceList>('/me/sessions');
				this.items = list.items;
				this.error = null;
			} catch (cause) {
				this.error = toApiClientError(cause);
			}
		},
		async revoke(id: string): Promise<void> {
			try {
				await useApi().delete(`/me/sessions/${id}`);
			} catch (cause) {
				throw toApiClientError(cause);
			}
			this.items = this.items?.filter((device) => device.id !== id);
		},
		async revokeOthers(): Promise<void> {
			try {
				await useApi().delete('/me/sessions');
			} catch (cause) {
				throw toApiClientError(cause);
			}
			this.items = this.items?.filter((device) => device.current);
		}
	}
});
