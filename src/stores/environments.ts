import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { EnvironmentKind, EnvironmentStatus } from '~/shared/environments';
import { useSessionStore } from '~/stores/session';

export interface SiteEnvironment {
	id: string;
	kind: EnvironmentKind;
	name: string;
	host: string;
	status: EnvironmentStatus;
	sourceBackupId: string | null;
	ttlAt: number | null;
	createdAt: number;
}

export interface EnvironmentList {
	items: SiteEnvironment[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

type Fetcher = (
	url: string,
	options: { method: 'POST' | 'DELETE'; headers: Record<string, string>; body?: unknown }
) => Promise<unknown>;

const envPath = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/environments`;

const keyOf = (orgId: string, siteId: string) => `${orgId}/${siteId}`;

// useApi has no header argument, so the Idempotency-Key calls go through $fetch
async function call<T>(
	method: 'POST' | 'DELETE',
	path: string,
	body: unknown,
	idempotencyKey: string
): Promise<T> {
	try {
		return (await ($fetch as unknown as Fetcher)(`/api/v1${path}`, {
			method,
			headers: { 'Idempotency-Key': idempotencyKey },
			...(body === undefined ? {} : { body })
		})) as T;
	} catch (error) {
		const apiError = toApiClientError(error);
		if (apiError.status === 401) useSessionStore().clear();
		throw apiError;
	}
}

export const useEnvironmentsStore = defineStore('environments', {
	state: () => ({
		// keyed by `orgId/siteId`; undefined: not loaded; an object: loaded
		lists: new Map<string, EnvironmentList>()
	}),
	getters: {
		listFor:
			(state) =>
			(orgId: string, siteId: string): EnvironmentList | undefined =>
				state.lists.get(keyOf(orgId, siteId))
	},
	actions: {
		async load(orgId: string, siteId: string): Promise<void> {
			const key = keyOf(orgId, siteId);
			const existing = this.lists.get(key);
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
			this.lists.set(key, { items: [], status: 'loading', error: null });
			try {
				const page = await useApi().get<{ items: SiteEnvironment[] }>(
					envPath(orgId, siteId)
				);
				this.lists.set(key, { items: page.items, status: 'ready', error: null });
			} catch (error) {
				this.lists.set(key, { items: [], status: 'error', error: toApiClientError(error) });
			}
		},
		async reload(orgId: string, siteId: string): Promise<void> {
			this.lists.delete(keyOf(orgId, siteId));
			await this.load(orgId, siteId);
		},
		async create(
			orgId: string,
			siteId: string,
			kind: 'staging' | 'dev',
			idempotencyKey: string
		): Promise<Operation> {
			const reply = await call<{ operation: Operation }>(
				'POST',
				envPath(orgId, siteId),
				{ kind },
				idempotencyKey
			);
			this.lists.delete(keyOf(orgId, siteId));
			return reply.operation;
		},
		async createPreview(
			orgId: string,
			siteId: string,
			ttlHours: number,
			idempotencyKey: string
		): Promise<Operation> {
			const reply = await call<{ operation: Operation }>(
				'POST',
				`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/previews`,
				{ ttlHours },
				idempotencyKey
			);
			this.lists.delete(keyOf(orgId, siteId));
			return reply.operation;
		},
		async remove(
			orgId: string,
			siteId: string,
			environmentId: string,
			idempotencyKey: string
		): Promise<Operation> {
			const operation = await call<Operation>(
				'DELETE',
				`${envPath(orgId, siteId)}/${encodeURIComponent(environmentId)}`,
				undefined,
				idempotencyKey
			);
			this.lists.delete(keyOf(orgId, siteId));
			return operation;
		}
	}
});
