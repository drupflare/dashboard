import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type { AccessPresetId } from '~/shared/access-presets';

export type AccessRuleView = {
	id: string;
	environment: string;
	preset: AccessPresetId;
	values: string[];
	expiresAt: number | null;
	createdBy: string;
	createdAt: number;
};

export type AccessPresetView = {
	id: AccessPresetId;
	label: string;
	available: boolean;
	unlockedBy: string | null;
};

export type AccessView = {
	rules: AccessRuleView[];
	// false while a change is being applied to the site, and when applying it failed
	activeOnSite?: boolean;
	presets: AccessPresetView[];
	inviteeLimit: number | null;
};

export type EnvironmentView = {
	id: string;
	kind: 'staging' | 'dev' | 'preview';
	name: string;
	status: string;
};

export type AddRuleBody = {
	environment: string;
	preset: AccessPresetId;
	values?: string[];
	password?: string;
	expiresInHours?: number;
};

// active is false when the rule is saved but the site has not picked it up yet
export type AddRuleResult = {
	active: boolean;
	rule?: AccessRuleView;
	linkToken?: string;
};

export type RemoveRuleResult = { active: boolean };

const NOT_ACTIVE = 'not_built';

// the change is saved and the site has not picked it up
const savedOnly = (failure: ApiClientError) =>
	failure.code === NOT_ACTIVE ||
	(failure.code === 'conflict' &&
		(failure.details as { saved?: boolean } | null)?.saved === true);

const base = (orgId: string, siteId: string) =>
	`/orgs/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}`;

export const useAccessStore = defineStore('access', {
	state: () => ({
		// keyed by site; undefined: not loaded; null: the site is not there; an object: loaded
		views: new Map<string, AccessView | null>(),
		// keyed by site; undefined: not loaded; null: no environment list; a list: loaded
		environments: new Map<string, EnvironmentView[] | null>(),
		errors: new Map<string, ApiClientError>()
	}),
	actions: {
		async read(orgId: string, siteId: string): Promise<AccessView | null> {
			try {
				const view = await useApi().get<AccessView>(`${base(orgId, siteId)}/access`);
				this.views.set(siteId, view);
				this.errors.delete(siteId);
				return view;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.views.set(siteId, null);
					this.errors.delete(siteId);
					return null;
				}
				this.errors.set(siteId, failure);
				throw failure;
			}
		},
		async loadEnvironments(orgId: string, siteId: string): Promise<EnvironmentView[]> {
			try {
				const page = await useApi().get<{ items: EnvironmentView[] }>(
					`${base(orgId, siteId)}/environments`
				);
				this.environments.set(siteId, page.items);
				return page.items;
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) {
					this.environments.set(siteId, null);
					return [];
				}
				throw failure;
			}
		},
		async addRule(orgId: string, siteId: string, body: AddRuleBody): Promise<AddRuleResult> {
			let result: AddRuleResult;
			try {
				const added = await useApi().post<{ rule: AccessRuleView; linkToken?: string }>(
					`${base(orgId, siteId)}/access/rules`,
					body
				);
				result = { active: true, ...added };
			} catch (error) {
				const failure = toApiClientError(error);
				if (!savedOnly(failure)) throw failure;
				result = { active: false };
			}
			await this.read(orgId, siteId).catch(() => undefined);
			return result;
		},
		async removeRule(orgId: string, siteId: string, ruleId: string): Promise<RemoveRuleResult> {
			let result: RemoveRuleResult;
			try {
				await useApi().delete<null>(
					`${base(orgId, siteId)}/access/rules/${encodeURIComponent(ruleId)}`
				);
				result = { active: true };
			} catch (error) {
				const failure = toApiClientError(error);
				if (!savedOnly(failure)) throw failure;
				result = { active: false };
			}
			await this.read(orgId, siteId).catch(() => undefined);
			return result;
		}
	}
});
