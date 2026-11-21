<script setup lang="ts">
import { type SiteGrantView } from '~/shared/members';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Collaborators' });

const route = useRoute();
const siteId = computed(() => String(route.params.id));
const session = useSessionStore();
const org = useOrgStore();
const members = useMembersStore();

const orgId = computed(() => org.current?.id ?? null);
// a collaborator with a site role may hold this without the organization role, and the server still decides
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canManage = computed(() => actions.value.includes('site.grant.manage'));

const key = computed(() => (orgId.value ? `${orgId.value}/${siteId.value}` : null));
const list = computed(() => (key.value ? members.grants.get(key.value) : undefined));
const grants = computed<SiteGrantView[]>(() => list.value?.items ?? []);

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (list.value === null) return 'no-site';
	if (!list.value || list.value.status === 'loading') return 'loading';
	if (list.value.status === 'error') return 'grants-error';
	return 'list';
});

function load() {
	if (orgId.value) void members.loadGrants(orgId.value, siteId.value);
}

onMounted(load);
watch([orgId, siteId], load);
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Collaborators"
				text="People with a role on this site, inside or outside the organization."
			/>

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
				v-else-if="view === 'no-site'"
				icon="i-lucide-lock"
				title="No Site Found"
				text="This site does not exist, or your account cannot see it."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading collaborators"
			/>

			<UiErrorState
				v-else-if="view === 'grants-error'"
				title="Could Not Load Collaborators"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="load"
					>Try Again</UButton
				>
			</UiErrorState>

			<TeamGrants
				v-else-if="orgId"
				:org-id="orgId"
				:site-id="siteId"
				:grants="grants"
				:can-manage="canManage"
			/>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
