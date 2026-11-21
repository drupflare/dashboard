import { defineStore } from 'pinia';
import { toApiClientError, useApi, type ApiClientError } from '~/composables/useApi';
import type {
	InviteCreateBody,
	InviteView,
	MemberPage,
	MemberView,
	RoleBody,
	SiteGrantBody,
	SiteGrantUpdate,
	SiteGrantView
} from '~/shared/members';

export interface MemberList {
	items: MemberView[];
	nextCursor: string | null;
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

export interface Loadable<T> {
	items: T[];
	status: 'loading' | 'ready' | 'error';
	error: ApiClientError | null;
}

const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`;
const sitePath = (orgId: string, siteId: string) =>
	`${orgPath(orgId)}/sites/${encodeURIComponent(siteId)}/grants`;

// the lists are keyed by org id or site id; undefined: not loaded; null: no such org or site; an object: loaded
export const useMembersStore = defineStore('members', {
	state: () => ({
		members: new Map<string, MemberList | null>(),
		invites: new Map<string, Loadable<InviteView> | null>(),
		grants: new Map<string, Loadable<SiteGrantView> | null>()
	}),
	actions: {
		async loadMembers(orgId: string): Promise<void> {
			const existing = this.members.get(orgId);
			if (
				existing === null ||
				existing?.status === 'ready' ||
				existing?.status === 'loading'
			) {
				return;
			}
			this.members.set(orgId, {
				items: [],
				nextCursor: null,
				status: 'loading',
				error: null
			});
			await this.fetchMembers(orgId, null);
		},
		async reloadMembers(orgId: string): Promise<void> {
			this.members.delete(orgId);
			await this.loadMembers(orgId);
		},
		async loadMoreMembers(orgId: string): Promise<void> {
			const list = this.members.get(orgId);
			if (!list?.nextCursor || list.status === 'loading') return;
			list.status = 'loading';
			await this.fetchMembers(orgId, list.nextCursor);
		},
		async fetchMembers(orgId: string, cursor: string | null): Promise<void> {
			try {
				const page = await useApi().get<MemberPage>(
					`${orgPath(orgId)}/members`,
					cursor ? { cursor } : undefined
				);
				const list = this.members.get(orgId);
				if (!list) return;
				list.items.push(...page.items);
				list.nextCursor = page.nextCursor;
				list.status = 'ready';
				list.error = null;
			} catch (cause) {
				const failure = toApiClientError(cause);
				if (failure.status === 404) {
					this.members.set(orgId, null);
					return;
				}
				const list = this.members.get(orgId);
				if (!list) return;
				list.status = 'error';
				list.error = failure;
			}
		},
		async changeRole(orgId: string, memberId: string, body: RoleBody): Promise<void> {
			const member = await useApi().put<MemberView>(
				`${orgPath(orgId)}/members/${encodeURIComponent(memberId)}/role`,
				body
			);
			const list = this.members.get(orgId);
			const at = list?.items.findIndex((item) => item.id === memberId) ?? -1;
			if (list && at >= 0) list.items[at] = member;
		},
		async removeMember(orgId: string, memberId: string): Promise<void> {
			await useApi().delete(`${orgPath(orgId)}/members/${encodeURIComponent(memberId)}`);
			const list = this.members.get(orgId);
			if (list) list.items = list.items.filter((item) => item.id !== memberId);
		},
		async loadInvites(orgId: string): Promise<void> {
			this.invites.set(orgId, { items: [], status: 'loading', error: null });
			try {
				const items = await useApi().get<InviteView[]>(`${orgPath(orgId)}/invites`);
				this.invites.set(orgId, { items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.invites.set(
					orgId,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		invite(orgId: string, body: InviteCreateBody): Promise<InviteView> {
			return useApi().post<InviteView>(`${orgPath(orgId)}/invites`, body);
		},
		async resendInvite(orgId: string, inviteId: string): Promise<void> {
			await useApi().post<InviteView>(
				`${orgPath(orgId)}/invites/${encodeURIComponent(inviteId)}/resend`,
				{}
			);
		},
		async revokeInvite(orgId: string, inviteId: string): Promise<void> {
			await useApi().post(
				`${orgPath(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
				{}
			);
			const list = this.invites.get(orgId);
			if (list) list.items = list.items.filter((item) => item.id !== inviteId);
		},
		async loadGrants(orgId: string, siteId: string): Promise<void> {
			const key = `${orgId}/${siteId}`;
			this.grants.set(key, { items: [], status: 'loading', error: null });
			try {
				const items = await useApi().get<SiteGrantView[]>(sitePath(orgId, siteId));
				this.grants.set(key, { items, status: 'ready', error: null });
			} catch (cause) {
				const failure = toApiClientError(cause);
				this.grants.set(
					key,
					failure.status === 404 ? null : { items: [], status: 'error', error: failure }
				);
			}
		},
		async grant(orgId: string, siteId: string, body: SiteGrantBody): Promise<SiteGrantView> {
			const grant = await useApi().post<SiteGrantView>(sitePath(orgId, siteId), body);
			const list = this.grants.get(`${orgId}/${siteId}`);
			if (list) list.items.push(grant);
			return grant;
		},
		async changeGrant(
			orgId: string,
			siteId: string,
			grantId: string,
			body: SiteGrantUpdate
		): Promise<void> {
			const grant = await useApi().put<SiteGrantView>(
				`${sitePath(orgId, siteId)}/${encodeURIComponent(grantId)}`,
				body
			);
			const list = this.grants.get(`${orgId}/${siteId}`);
			const at = list?.items.findIndex((item) => item.id === grantId) ?? -1;
			if (list && at >= 0) list.items[at] = grant;
		},
		async revokeGrant(orgId: string, siteId: string, grantId: string): Promise<void> {
			await useApi().delete(`${sitePath(orgId, siteId)}/${encodeURIComponent(grantId)}`);
			const list = this.grants.get(`${orgId}/${siteId}`);
			if (list) list.items = list.items.filter((item) => item.id !== grantId);
		},
		reset(): void {
			this.members.clear();
			this.invites.clear();
			this.grants.clear();
		}
	}
});
