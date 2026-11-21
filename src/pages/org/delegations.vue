<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { DelegationCreate } from '~/shared/agency';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useDelegationsStore } from '~/stores/delegations';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Agency Access' });

const org = useOrgStore();
const delegations = useDelegationsStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canRead = computed(() => actions.value.includes('delegation.read'));
const canCreate = computed(() => actions.value.includes('delegation.create'));
const canAccept = computed(() => actions.value.includes('delegation.accept'));
const canRevoke = computed(() => actions.value.includes('delegation.revoke'));

const state = computed(() => (orgId.value ? delegations.lists.get(orgId.value) : undefined));
const data = computed(() => state.value?.data ?? null);

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!canRead.value && org.current) return 'no-access';
	if (state.value === null) return 'no-org';
	if (!state.value || state.value.status === 'loading') return 'loading';
	if (state.value.status === 'error') return 'list-error';
	if (!data.value || (data.value.sent.length === 0 && data.value.received.length === 0)) {
		return 'empty';
	}
	return 'list';
});

const formOpen = ref(false);
const formBusy = ref(false);
const formError = ref<string | null>(null);
const actionError = ref<string | null>(null);

function loadAccess(id: string) {
	if (canRead.value) void delegations.load(id);
}

onMounted(() => {
	if (orgId.value) loadAccess(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadAccess(id);
});

function reloadAccess() {
	if (orgId.value) void delegations.reload(orgId.value);
}

function openForm() {
	formError.value = null;
	formOpen.value = true;
}

async function create(body: DelegationCreate) {
	if (!orgId.value) return;
	formBusy.value = true;
	formError.value = null;
	try {
		await delegations.create(orgId.value, body);
		formOpen.value = false;
		reloadAccess();
	} catch (cause) {
		formError.value = toApiClientError(cause).message;
	} finally {
		formBusy.value = false;
	}
}

async function answer(verb: 'accept' | 'revoke', id: string) {
	if (!orgId.value) return;
	actionError.value = null;
	try {
		if (verb === 'accept') await delegations.accept(orgId.value, id);
		else await delegations.revoke(orgId.value, id);
	} catch (cause) {
		actionError.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Agency Access"
				text="Give an agency organization access to some or all of your sites. Each person's rights are capped by their role in the agency."
			>
				<UButton
					v-if="orgId && canCreate"
					@click="openForm"
					>Give Agency Access</UButton
				>
			</UiPageHeader>

			<UiErrorState
				v-if="view === 'org-error'"
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
				title="Your Role Cannot See Agency Access"
				text="Ask an owner or an admin of this organization to share this view with you."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading agency access"
			/>

			<UiErrorState
				v-else-if="view === 'list-error'"
				title="Could Not Load Agency Access"
				:text="state?.error?.message"
				:request-id="state?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadAccess"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-handshake"
				title="No Agency Access Yet"
				text="Give an agency access to your sites, or accept access that an agency offers you."
			/>

			<template v-else-if="data">
				<p
					v-if="actionError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ actionError }}
				</p>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Access Given to Agencies</h2>
					<AgencyDelegationList
						v-if="data.sent.length"
						:items="data.sent"
						direction="sent"
						:can-accept="canAccept"
						:can-revoke="canRevoke"
						@accept="answer('accept', $event)"
						@revoke="answer('revoke', $event)"
					/>
					<p
						v-else
						class="text-sm text-muted"
					>
						This organization has not given any agency access.
					</p>
				</section>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">
						Access Received From Clients
					</h2>
					<AgencyDelegationList
						v-if="data.received.length"
						:items="data.received"
						direction="received"
						:can-accept="canAccept"
						:can-revoke="canRevoke"
						@accept="answer('accept', $event)"
						@revoke="answer('revoke', $event)"
					/>
					<p
						v-else
						class="text-sm text-muted"
					>
						No client has given this organization access yet.
					</p>
				</section>
			</template>

			<UModal
				v-if="canCreate"
				v-model:open="formOpen"
				title="Give Agency Access"
				description="Pick the agency, the role and the sites. The agency's admin has to accept before any access starts."
			>
				<template #body>
					<AgencyDelegationForm
						:busy="formBusy"
						:error="formError"
						@submit="create"
					/>
				</template>
			</UModal>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
