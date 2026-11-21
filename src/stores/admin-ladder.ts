import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

export type LadderScope = 'global' | 'organization' | 'site';

export interface LadderRow {
	repairId: string;
	source: string;
	severity: string;
	handle: string;
	automation: string;
	canRunToday: boolean;
	reason: string | null;
}

export interface LadderSwitch {
	scope: LadderScope;
	scopeId: string;
	auto: boolean;
	updatedAt: number;
}

interface LadderPage {
	rows: LadderRow[];
	switches: LadderSwitch[];
}

export const useAdminLadderStore = defineStore('admin-ladder', {
	state: () => ({
		rows: [] as LadderRow[],
		switches: [] as LadderSwitch[],
		status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
		error: null as ApiClientError | null
	}),
	actions: {
		async load(): Promise<void> {
			this.status = 'loading';
			this.error = null;
			try {
				const page = await useApi().get<LadderPage>('/admin/ladder');
				this.rows = page.rows;
				this.switches = page.switches;
				this.status = 'ready';
			} catch (error) {
				this.error = toApiClientError(error);
				this.status = 'error';
				if (this.error.status === 401) useSessionStore().clear();
			}
		},
		async setSwitch(
			scope: LadderScope,
			scopeId: string,
			auto: boolean,
			confirmation?: string
		): Promise<void> {
			try {
				await useApi().put('/admin/ladder/switch', {
					scope,
					scopeId,
					auto,
					...(confirmation === undefined ? {} : { confirmation })
				});
			} catch (error) {
				const apiError = toApiClientError(error);
				if (apiError.status === 401) useSessionStore().clear();
				throw apiError;
			}
			await this.load();
		}
	}
});
