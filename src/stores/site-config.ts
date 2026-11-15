import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { SettingsView } from '~/shared/site-config/view';
import { useSessionStore } from '~/stores/session';

export type { SettingsField, SettingsGroup, SettingsView } from '~/shared/site-config/view';

export interface SettingChange {
	key: string;
	value: string | number | null;
}

export interface SettingChangeView {
	id: string;
	operationId: string;
	key: string;
	label: string;
	before: unknown;
	after: unknown;
	actor: string;
	status: 'pending' | 'applied' | 'unverified' | 'failed';
	createdAt: string;
	reverted: boolean;
	revertable: boolean;
}

// what the site holds now for the keys a write touched, sent back with a conflict
export interface SettingsConflict {
	etag: string;
	current: Record<string, unknown>;
}

const base = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/settings`;

type PutFetcher = (
	url: string,
	options: { method: 'PUT'; headers: Record<string, string>; body: Record<string, unknown> }
) => Promise<Operation>;

function failed(error: unknown): ApiClientError {
	const apiError = toApiClientError(error);
	if (apiError.status === 401) useSessionStore().clear();
	return apiError;
}

export function conflictOf(error: ApiClientError): SettingsConflict | null {
	if (error.status !== 409) return null;
	const details = error.details as Partial<SettingsConflict> | null;
	if (typeof details?.etag !== 'string' || details.current === undefined) return null;
	return { etag: details.etag, current: details.current };
}

export const useSiteConfigStore = defineStore('site-config', {
	state: () => ({
		// keyed by site id; undefined: not loaded; null: known absent; an object: loaded
		bySite: new Map<string, SettingsView | null>(),
		errors: new Map<string, ApiClientError>(),
		history: new Map<string, SettingChangeView[] | null>(),
		historyErrors: new Map<string, ApiClientError>()
	}),
	actions: {
		async read(orgId: string, siteId: string, fresh = false): Promise<SettingsView | null> {
			try {
				const view = await useApi().get<SettingsView>(
					base(orgId, siteId),
					fresh ? { fresh: '1' } : undefined
				);
				this.bySite.set(siteId, view);
				this.errors.delete(siteId);
				return view;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.bySite.set(siteId, null);
					this.errors.delete(siteId);
					return null;
				}
				this.errors.set(siteId, failure);
				throw failure;
			}
		},
		// useApi has no PUT, so the Idempotency-Key call goes through $fetch as the backups store does
		async write(
			orgId: string,
			siteId: string,
			etag: string,
			changes: SettingChange[],
			idempotencyKey: string
		): Promise<Operation> {
			const fetcher = $fetch as unknown as PutFetcher;
			try {
				return await fetcher(`/api/v1${base(orgId, siteId)}`, {
					method: 'PUT',
					headers: { 'Idempotency-Key': idempotencyKey },
					body: { etag, changes }
				});
			} catch (error) {
				throw failed(error);
			}
		},
		async loadHistory(orgId: string, siteId: string): Promise<void> {
			try {
				const page = await useApi().get<{ items: SettingChangeView[] }>(
					`${base(orgId, siteId)}/history`
				);
				this.history.set(siteId, page.items);
				this.historyErrors.delete(siteId);
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.history.set(siteId, null);
					this.historyErrors.delete(siteId);
					return;
				}
				this.historyErrors.set(siteId, failure);
				throw failure;
			}
		},
		async revert(
			orgId: string,
			siteId: string,
			changeId: string,
			idempotencyKey: string
		): Promise<Operation> {
			try {
				return await useApi().post<Operation>(
					`${base(orgId, siteId)}/history/${encodeURIComponent(changeId)}/revert`,
					undefined,
					{ 'Idempotency-Key': idempotencyKey }
				);
			} catch (error) {
				throw failed(error);
			}
		},
		reset(): void {
			this.bySite.clear();
			this.errors.clear();
			this.history.clear();
			this.historyErrors.clear();
		}
	}
});
