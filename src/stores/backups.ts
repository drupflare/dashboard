import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { RestoreLayerOffer, RestorePoint } from '~/shared/restore-points';
import { useSessionStore } from '~/stores/session';

export interface BackupView {
	id: string;
	siteId: string;
	operationId: string;
	bytes: number;
	sha256: string;
	parts: number;
	restorable: boolean;
	notRestorableReason: string | null;
	verified: boolean;
	label: string | null;
	createdAt: string;
}

export interface BackupList {
	items: BackupView[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

export interface RestorePointList {
	items: RestorePoint[];
	layers: RestoreLayerOffer[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

export interface BackupFile {
	blob: Blob;
	filename: string;
}

interface BackupPage {
	items: BackupView[];
	nextCursor: string | null;
}

interface RestorePointPage {
	items: RestorePoint[];
	nextCursor: string | null;
	layers: RestoreLayerOffer[];
}

type PostFetcher = (
	url: string,
	options: { method: 'POST'; headers: Record<string, string>; body: Record<string, unknown> }
) => Promise<Operation>;

type RawFetcher = (
	url: string,
	options: { responseType: 'blob' }
) => Promise<{ _data: Blob; headers: Headers }>;

const backupsPath = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/backups`;

const restorePointsPath = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/restore-points`;

const keyOf = (orgId: string, siteId: string) => `${orgId}/${siteId}`;

// useApi has no header argument, so the Idempotency-Key calls go through $fetch
function failed(error: unknown): ApiClientError {
	const apiError = toApiClientError(error);
	if (apiError.status === 401) useSessionStore().clear();
	return apiError;
}

async function post(
	path: string,
	body: Record<string, unknown>,
	idempotencyKey: string
): Promise<Operation> {
	const fetcher = $fetch as unknown as PostFetcher;
	try {
		return await fetcher(`/api/v1${path}`, {
			method: 'POST',
			headers: { 'Idempotency-Key': idempotencyKey },
			body
		});
	} catch (error) {
		throw failed(error);
	}
}

function filenameFrom(disposition: string | null, fallback: string): string {
	return disposition?.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}

export const useBackupsStore = defineStore('backups', {
	state: () => ({
		// keyed by `orgId/siteId`; undefined: not loaded; an object: loaded
		lists: new Map<string, BackupList>(),
		// keyed by `orgId/siteId`; undefined: not loaded; an object: loaded
		restorePoints: new Map<string, RestorePointList>()
	}),
	getters: {
		listFor:
			(state) =>
			(orgId: string, siteId: string): BackupList | undefined =>
				state.lists.get(keyOf(orgId, siteId)),
		restorePointsFor:
			(state) =>
			(orgId: string, siteId: string): RestorePointList | undefined =>
				state.restorePoints.get(keyOf(orgId, siteId))
	},
	actions: {
		async load(orgId: string, siteId: string): Promise<void> {
			const existing = this.lists.get(keyOf(orgId, siteId));
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
			this.lists.set(keyOf(orgId, siteId), {
				items: [],
				nextCursor: null,
				status: 'loading',
				error: null
			});
			await this.fetchPage(orgId, siteId, null);
		},
		async reload(orgId: string, siteId: string): Promise<void> {
			this.lists.delete(keyOf(orgId, siteId));
			await this.load(orgId, siteId);
		},
		async loadMore(orgId: string, siteId: string): Promise<void> {
			const list = this.lists.get(keyOf(orgId, siteId));
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchPage(orgId, siteId, list.nextCursor);
		},
		async fetchPage(orgId: string, siteId: string, cursor: string | null): Promise<void> {
			const key = keyOf(orgId, siteId);
			try {
				const page = await useApi().get<BackupPage>(
					backupsPath(orgId, siteId),
					cursor ? { cursor } : undefined
				);
				const list = this.lists.get(key);
				if (!list) return;
				list.items.push(...page.items);
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (error) {
				const list = this.lists.get(key);
				if (!list) return;
				list.status = 'error';
				list.error = toApiClientError(error);
			}
		},
		async loadRestorePoints(orgId: string, siteId: string): Promise<void> {
			const existing = this.restorePoints.get(keyOf(orgId, siteId));
			if (existing?.status === 'ready' || existing?.status === 'loading') return;
			this.restorePoints.set(keyOf(orgId, siteId), {
				items: [],
				layers: [],
				nextCursor: null,
				status: 'loading',
				error: null
			});
			await this.fetchRestorePoints(orgId, siteId, null);
		},
		async reloadRestorePoints(orgId: string, siteId: string): Promise<void> {
			this.restorePoints.delete(keyOf(orgId, siteId));
			await this.loadRestorePoints(orgId, siteId);
		},
		async loadMoreRestorePoints(orgId: string, siteId: string): Promise<void> {
			const list = this.restorePoints.get(keyOf(orgId, siteId));
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchRestorePoints(orgId, siteId, list.nextCursor);
		},
		async fetchRestorePoints(
			orgId: string,
			siteId: string,
			cursor: string | null
		): Promise<void> {
			const key = keyOf(orgId, siteId);
			try {
				const page = await useApi().get<RestorePointPage>(
					restorePointsPath(orgId, siteId),
					cursor ? { cursor } : undefined
				);
				const list = this.restorePoints.get(key);
				if (!list) return;
				list.items.push(...page.items);
				list.layers = page.layers;
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (error) {
				const list = this.restorePoints.get(key);
				if (!list) return;
				list.status = 'error';
				list.error = toApiClientError(error);
			}
		},
		startBackup(orgId: string, siteId: string, idempotencyKey: string): Promise<Operation> {
			return post(backupsPath(orgId, siteId), {}, idempotencyKey);
		},
		restore(
			orgId: string,
			siteId: string,
			backupId: string,
			targetSiteId: string,
			idempotencyKey: string
		): Promise<Operation> {
			return post(
				`${backupsPath(orgId, siteId)}/${encodeURIComponent(backupId)}/restore`,
				{ targetSiteId },
				idempotencyKey
			);
		},
		verify(
			orgId: string,
			siteId: string,
			backupId: string,
			idempotencyKey: string
		): Promise<Operation> {
			return post(
				`${backupsPath(orgId, siteId)}/${encodeURIComponent(backupId)}/verify`,
				{},
				idempotencyKey
			);
		},
		schedulePitr(
			orgId: string,
			siteId: string,
			at: number,
			idempotencyKey: string
		): Promise<Operation> {
			const site = `/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}`;
			return post(`${site}/restore-points/pitr`, { at }, idempotencyKey);
		},
		async download(orgId: string, siteId: string, backupId: string): Promise<BackupFile> {
			const fetcher = $fetch.raw as unknown as RawFetcher;
			try {
				const response = await fetcher(
					`/api/v1${backupsPath(orgId, siteId)}/${encodeURIComponent(backupId)}/export`,
					{ responseType: 'blob' }
				);
				return {
					blob: response._data,
					filename: filenameFrom(
						response.headers.get('content-disposition'),
						`${backupId}.sql`
					)
				};
			} catch (error) {
				throw failed(error);
			}
		},
		reset(): void {
			this.lists.clear();
			this.restorePoints.clear();
		}
	}
});
