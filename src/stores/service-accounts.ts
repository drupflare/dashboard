import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { KeyCreateBody, KeyCreated, KeyView } from '~/shared/api-keys';
import type {
	ServiceAccountCreateBody,
	ServiceAccountKeyList,
	ServiceAccountList,
	ServiceAccountView
} from '~/shared/service-accounts';

export interface AccountLoad<T> {
	items: T[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/service-accounts`;
const accountPath = (orgId: string, id: string) => `${orgPath(orgId)}/${encodeURIComponent(id)}`;

// accounts are keyed by organization id and keys by organization and account; undefined: not
// loaded; null: no such organization or account; an object: loaded
export const useServiceAccountsStore = defineStore('service-accounts', {
	state: () => ({
		accounts: new Map<string, AccountLoad<ServiceAccountView> | null>(),
		keys: new Map<string, AccountLoad<KeyView> | null>()
	}),
	actions: {
		async loadAccounts(orgId: string): Promise<void> {
			const existing = this.accounts.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			await this.fetchAccounts(orgId);
		},
		async fetchAccounts(orgId: string): Promise<void> {
			this.accounts.set(orgId, { items: [], status: 'loading', error: null });
			try {
				const list = await useApi().get<ServiceAccountList>(orgPath(orgId));
				this.accounts.set(orgId, { items: list.items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.accounts.set(
					orgId,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		async create(orgId: string, body: ServiceAccountCreateBody): Promise<ServiceAccountView> {
			const created = await useApi().post<ServiceAccountView>(orgPath(orgId), body);
			await this.fetchAccounts(orgId);
			return created;
		},
		async disable(orgId: string, id: string): Promise<void> {
			await useApi().post(`${accountPath(orgId, id)}/disable`, {});
			this.keys.delete(`${orgId}/${id}`);
			await this.fetchAccounts(orgId);
		},
		async loadKeys(orgId: string, id: string): Promise<void> {
			const key = `${orgId}/${id}`;
			this.keys.set(key, { items: [], status: 'loading', error: null });
			try {
				const list = await useApi().get<ServiceAccountKeyList>(
					`${accountPath(orgId, id)}/keys`
				);
				this.keys.set(key, { items: list.items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.keys.set(
					key,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		// the token comes back once and is not kept here
		async issueKey(orgId: string, id: string, body: KeyCreateBody): Promise<KeyCreated> {
			const created = await useApi().post<KeyCreated>(`${accountPath(orgId, id)}/keys`, body);
			await Promise.all([this.loadKeys(orgId, id), this.fetchAccounts(orgId)]);
			return created;
		}
	}
});
