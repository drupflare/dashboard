<script setup lang="ts">
import { claudeMcpAddCommand, KEY_SCOPE_COPY } from '~/shared/api-keys';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useApiKeysStore } from '~/stores/api-keys';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'API Keys' });

const session = useSessionStore();
const org = useOrgStore();
const keys = useApiKeysStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canRead = computed(() => actions.value.includes('key.read'));
const canCreate = computed(() => actions.value.includes('key.create'));
const canRevoke = computed(() => actions.value.includes('key.revoke'));
const offered = computed(() => actions.value.filter((action) => action in KEY_SCOPE_COPY));

const list = computed(() => (orgId.value ? keys.lists.get(orgId.value) : undefined));
const items = computed(() => list.value?.items ?? []);
const command = claudeMcpAddCommand();

const view = computed(() => {
	if (session.me === undefined && session.error) return 'session-error';
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!canRead.value && org.current) return 'no-access';
	if (list.value === null) return 'no-org';
	if (!list.value || (list.value.status === 'loading' && items.value.length === 0)) {
		return 'loading';
	}
	if (items.value.length === 0 && list.value.status === 'error') return 'keys-error';
	if (items.value.length === 0) return 'empty';
	return 'list';
});

function loadKeys(id: string) {
	if (canRead.value) void keys.load(id);
}

onMounted(() => {
	if (orgId.value) loadKeys(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadKeys(id);
});

function reloadKeys() {
	if (orgId.value) void keys.reload(orgId.value);
}

function loadMore() {
	if (orgId.value) void keys.loadMore(orgId.value);
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="API Keys"
				text="Keys let a script or an AI client act in this organization with only the permissions you pick."
			>
				<KeyCreateDialog
					v-if="orgId && canCreate"
					:org-id="orgId"
					:offered="offered"
					@closed="reloadKeys()"
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
				title="Your Role Cannot Manage Keys"
				text="Ask an owner, an admin or a developer of this organization to create a key for you."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading keys"
			/>

			<UiErrorState
				v-else-if="view === 'keys-error'"
				title="Could Not Load Keys"
				:text="list?.error?.message"
				:request-id="list?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadKeys"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-key-round"
				title="No Keys Yet"
				text="Create a key to connect a script or an AI client."
			/>

			<template v-else>
				<KeyTable
					:org-id="orgId ?? ''"
					:keys="items"
					:can-revoke="canRevoke"
				/>
				<p
					v-if="list?.status === 'error'"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					Could not load more keys.
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
			</template>

			<section
				v-if="canRead"
				class="flex flex-col gap-2"
			>
				<h2 class="text-lg font-semibold text-highlighted">Connect an AI Client</h2>
				<p class="text-sm text-default">
					Claude Code reaches this API through the MyMCP gateway. After you create a key,
					run this command and replace the placeholder with the key. The key goes in a
					header and never in the address.
				</p>
				<code
					data-command
					class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
					>{{ command }}</code
				>
			</section>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
