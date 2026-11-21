import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type {
	AssignmentKind,
	Classification,
	ClassificationEntry,
	PolicyGroupBody,
	PolicyGroupView,
	PolicyList,
	SiteClassificationView
} from '~/shared/policies';

export interface PoliciesEntry {
	items: PolicyGroupView[];
	classifications: ClassificationEntry[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`;
const policyPath = (orgId: string, id: string) =>
	`${orgPath(orgId)}/policies/${encodeURIComponent(id)}`;

// keyed by organization id; undefined: not loaded; null: no such organization; an object: loaded
export const usePoliciesStore = defineStore('policies', {
	state: () => ({
		policies: new Map<string, PoliciesEntry | null>()
	}),
	actions: {
		async load(orgId: string): Promise<void> {
			const existing = this.policies.get(orgId);
			if (existing === null || existing?.status === 'ready' || existing?.status === 'loading')
				return;
			await this.fetch(orgId);
		},
		async fetch(orgId: string): Promise<void> {
			this.policies.set(orgId, {
				items: [],
				classifications: [],
				status: 'loading',
				error: null
			});
			try {
				const list = await useApi().get<PolicyList>(`${orgPath(orgId)}/policies`);
				this.policies.set(orgId, {
					items: list.items,
					classifications: list.classifications,
					status: 'ready',
					error: null
				});
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.policies.set(
					orgId,
					failure.status === 404
						? null
						: { items: [], classifications: [], status: 'error', error: failure }
				);
			}
		},
		async create(orgId: string, body: PolicyGroupBody): Promise<PolicyGroupView> {
			const created = await useApi().post<PolicyGroupView>(
				`${orgPath(orgId)}/policies`,
				body
			);
			await this.fetch(orgId);
			return created;
		},
		async update(orgId: string, id: string, body: PolicyGroupBody): Promise<PolicyGroupView> {
			const updated = await useApi().put<PolicyGroupView>(policyPath(orgId, id), body);
			await this.fetch(orgId);
			return updated;
		},
		async remove(orgId: string, id: string): Promise<void> {
			await useApi().delete(policyPath(orgId, id));
			await this.fetch(orgId);
		},
		async assign(
			orgId: string,
			id: string,
			target: { kind: AssignmentKind; targetId: string }
		): Promise<void> {
			await useApi().post(`${policyPath(orgId, id)}/assignments`, target);
			await this.fetch(orgId);
		},
		async unassign(
			orgId: string,
			id: string,
			target: { kind: AssignmentKind; targetId: string }
		): Promise<void> {
			await useApi().delete(
				`${policyPath(orgId, id)}/assignments/${target.kind}/${encodeURIComponent(target.targetId)}`
			);
			await this.fetch(orgId);
		},
		async nameLabel(
			orgId: string,
			label: Classification,
			displayName: string | null
		): Promise<void> {
			await useApi().put(`${orgPath(orgId)}/policies/classifications/${label}`, {
				displayName
			});
			await this.fetch(orgId);
		},
		async classifySite(
			orgId: string,
			siteId: string,
			classification: Classification | null
		): Promise<SiteClassificationView> {
			return useApi().put<SiteClassificationView>(
				`${orgPath(orgId)}/sites/${encodeURIComponent(siteId)}/classification`,
				{ classification }
			);
		},
		reset(): void {
			this.policies.clear();
		}
	}
});
