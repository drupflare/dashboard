import type { Operation } from '@contracts/operations';
import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { ModuleCheck, ModuleListItem, ModuleQuery } from '~/shared/modules';
import { useOperationsStore } from '~/stores/operations';

const base = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/modules`;

export const moduleListKey = (siteId: string, query: ModuleQuery) =>
	`${siteId}|${query.q ?? ''}|${query.state ?? ''}|${query.kind ?? ''}`;

export type ModuleChange = 'install' | 'enable' | 'remove' | 'theme-default';

export const changeKey = (siteId: string, name: string, change: ModuleChange) =>
	`${siteId}|${name}|${change}`;

// how long the page waits between reads of a running change; a test sets it to 0
export const poll = { ms: 2_000 };

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'rolled-back']);
export const hasEnded = (operation: Pick<Operation, 'status'>) => ENDED.has(operation.status);

export const useModulesStore = defineStore('modules', {
	state: () => ({
		// keyed by site and query; undefined: not loaded; null: the site is not there; a list: loaded
		lists: new Map<string, ModuleListItem[] | null>(),
		// keyed by site and module name; the last check answered, not cached between clicks
		checks: new Map<string, ModuleCheck>(),
		// keyed by site, module name and change; the last operation started, as it was last read
		changes: new Map<string, Operation>(),
		errors: new Map<string, ApiClientError>()
	}),
	actions: {
		async search(
			orgId: string,
			siteId: string,
			query: ModuleQuery
		): Promise<ModuleListItem[] | null> {
			const params: Record<string, string> = {};
			if (query.q) params['q'] = query.q;
			if (query.state) params['state'] = query.state;
			if (query.kind) params['kind'] = query.kind;
			const key = moduleListKey(siteId, query);
			try {
				const page = await useApi().get<{ items: ModuleListItem[] }>(
					base(orgId, siteId),
					params
				);
				this.lists.set(key, page.items);
				this.errors.delete(key);
				return page.items;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.lists.set(key, null);
					this.errors.delete(key);
					return null;
				}
				this.errors.set(key, failure);
				throw failure;
			}
		},
		async check(orgId: string, siteId: string, name: string): Promise<ModuleCheck> {
			const result = await useApi().post<ModuleCheck>(`${base(orgId, siteId)}/check`, {
				name
			});
			this.checks.set(`${siteId}|${name}`, result);
			return result;
		},
		async change(
			orgId: string,
			siteId: string,
			change: ModuleChange,
			body: { name: string; confirm?: boolean; target?: 'default' | 'admin' }
		): Promise<Operation> {
			const operation = await useApi().post<Operation>(
				`${base(orgId, siteId)}/${change}`,
				body,
				{ 'Idempotency-Key': crypto.randomUUID() }
			);
			this.changes.set(changeKey(siteId, body.name, change), operation);
			return operation;
		},
		// reads the operation until it ends, keeping the last answer for the screen to show
		async follow(
			orgId: string,
			siteId: string,
			change: ModuleChange,
			operation: Operation,
			name: string
		): Promise<Operation> {
			let current = operation;
			while (!hasEnded(current)) {
				await new Promise((resolve) => setTimeout(resolve, poll.ms));
				const next = await useOperationsStore().fetchOne(orgId, operation.id);
				if (next === null) break;
				current = next;
				this.changes.set(changeKey(siteId, name, change), current);
			}
			return current;
		}
	}
});
