<script setup lang="ts">
import { type InviteView, type MemberView } from '~/shared/members';
import { isOrgRole, ORG_ROLE_ACTIONS, type OrgRole } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Members' });

const session = useSessionStore();
const org = useOrgStore();
const members = useMembersStore();

const orgId = computed(() => org.current?.id ?? null);
const role = computed<OrgRole | null>(() =>
	isOrgRole(org.current?.role) ? org.current.role : null
);
const actions = computed<readonly string[]>(() => (role.value ? ORG_ROLE_ACTIONS[role.value] : []));
const canRead = computed(() => actions.value.includes('member.read'));
const canInvite = computed(() => actions.value.includes('member.invite'));

const list = computed(() => (orgId.value ? members.members.get(orgId.value) : undefined));
const rows = computed<MemberView[]>(() => list.value?.items ?? []);
const invites = computed<InviteView[]>(() => {
	const loaded = orgId.value ? members.invites.get(orgId.value) : undefined;
	return loaded?.items ?? [];
});

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (org.current && !canRead.value) return 'no-access';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && rows.value.length === 0))
		return 'loading';
	if (rows.value.length === 0 && list.value.status === 'error') return 'members-error';
	return 'list';
});

function loadAll(id: string) {
	if (!canRead.value) return;
	void members.loadMembers(id);
	if (canInvite.value) void members.loadInvites(id);
}

onMounted(() => {
	if (orgId.value) loadAll(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadAll(id);
});

function reloadMembers() {
	if (orgId.value) void members.reloadMembers(orgId.value);
}

function reloadInvites() {
	if (orgId.value) void members.loadInvites(orgId.value);
}

const offboarding = ref<MemberView | null>(null);
const offboardOpen = ref(false);

function askOffboard(member: MemberView) {
	offboarding.value = member;
	offboardOpen.value = true;
}

function offboardCandidates(target: MemberView) {
	return rows.value
		.filter((member) => member.id !== target.id)
		.map((member) => ({ userId: member.userId, label: member.displayName ?? member.email }));
}

function loadMore() {
	if (orgId.value) void members.loadMoreMembers(orgId.value);
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Members"
				text="People who work in this organization, and what each one can do."
			>
				<TeamInviteDialog
					v-if="orgId && canInvite && role"
					:org-id="orgId"
					:actor-role="role"
					@invited="reloadInvites()"
				/>
			</UiPageHeader>

			<UiErrorState
				v-if="view === 'session-error'"
				title="Could Not Load Your Account"
				:text="session.error?.message"
				:request-id="session.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="session.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiErrorState
				v-else-if="view === 'org-error'"
				title="Could Not Load Organizations"
				:text="org.error?.message"
				:request-id="org.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="org.load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'no-org'"
				icon="i-lucide-building-2"
				title="No Organization Found"
				text="Sign out and sign in again to set up your organization."
			/>

			<UiEmptyState
				v-else-if="view === 'no-access'"
				icon="i-lucide-lock"
				title="Your Role Cannot See Members"
				text="Ask an owner or an admin of this organization for the member list."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading members"
			/>

			<UiErrorState
				v-else-if="view === 'members-error'"
				title="Could Not Load Members"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadMembers"
					>Try Again</UButton
				>
			</UiErrorState>

			<template v-else>
				<TeamMembers
					v-if="orgId && role"
					:org-id="orgId"
					:actor-role="role"
					:members="rows"
					:self-user-id="session.me?.id ?? null"
					@offboard="askOffboard"
				/>
				<p
					v-if="list?.status === 'error'"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					Could not load more members.
					<UButton
						color="neutral"
						variant="link"
						@click="loadMore"
						>Try Again</UButton
					>
				</p>
				<div
					v-if="list?.nextCursor"
					class="flex justify-center"
				>
					<UButton
						color="neutral"
						variant="outline"
						:loading="list.status === 'loading'"
						@click="loadMore"
						>Load More</UButton
					>
				</div>

				<TeamOffboardDialog
					v-if="offboarding && orgId"
					v-model:open="offboardOpen"
					:org-id="orgId"
					:member-id="offboarding.id"
					:member-name="offboarding.displayName ?? offboarding.email"
					:candidates="offboardCandidates(offboarding)"
					@done="reloadMembers()"
				/>
				<section
					v-if="canInvite"
					class="flex flex-col gap-3"
				>
					<h2 class="text-lg font-semibold text-highlighted">Pending Invitations</h2>
					<TeamInvites
						v-if="orgId"
						:org-id="orgId"
						:invites="invites"
						:can-manage="canInvite"
					/>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
