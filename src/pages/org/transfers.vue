<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useOrgStore } from '~/stores/org';
import { useTransfersStore } from '~/stores/transfers';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Site Transfers' });

const org = useOrgStore();
const transfers = useTransfersStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canRead = computed(() => actions.value.includes('transfer.read'));
const canAnswer = computed(() => actions.value.includes('transfer.accept'));
const canCancel = computed(() => actions.value.includes('site.transfer'));

const state = computed(() => (orgId.value ? transfers.lists.get(orgId.value) : undefined));
const data = computed(() => state.value?.data ?? null);

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (!canRead.value && org.current) return 'no-access';
	if (state.value === null) return 'no-org';
	if (!state.value || state.value.status === 'loading') return 'loading';
	if (state.value.status === 'error') return 'list-error';
	if (!data.value || (data.value.outgoing.length === 0 && data.value.incoming.length === 0)) {
		return 'empty';
	}
	return 'list';
});

const actionError = ref<string | null>(null);

function loadTransfers(id: string) {
	if (canRead.value) void transfers.load(id);
}

onMounted(() => {
	if (orgId.value) loadTransfers(orgId.value);
});

watch(orgId, (id) => {
	if (id) loadTransfers(id);
});

function reloadTransfers() {
	if (orgId.value) void transfers.reload(orgId.value);
}

type Step = 'accept' | 'decline' | 'complete';

async function answer(step: Step, id: string) {
	if (!orgId.value) return;
	actionError.value = null;
	try {
		await transfers[step](orgId.value, id);
	} catch (cause) {
		actionError.value = toApiClientError(cause).message;
	}
}

async function cancel(siteId: string, id: string) {
	if (!orgId.value) return;
	actionError.value = null;
	try {
		await transfers.cancel(orgId.value, siteId, id);
	} catch (cause) {
		actionError.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Site Transfers"
				text="Move a site to another organization. The sending owner proposes, the receiving owner accepts, and then the move completes. Start a proposal from the site's page."
			/>

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
				title="Your Role Cannot See Transfers"
				text="Ask an owner or an admin of this organization to share this view with you."
			/>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading site transfers"
			/>

			<UiErrorState
				v-else-if="view === 'list-error'"
				title="Could Not Load Transfers"
				:text="state?.error?.message"
				:request-id="state?.error?.requestId"
			>
				<UButton
					color="neutral"
					@click="reloadTransfers"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiEmptyState
				v-else-if="view === 'empty'"
				icon="i-lucide-arrow-left-right"
				title="No Transfers Yet"
				text="When a site moves to or from this organization, it appears here."
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
					<h2 class="text-lg font-semibold text-highlighted">Sites Moving Out</h2>
					<AgencyTransferFlow
						v-for="item in data.outgoing"
						:key="item.id"
						:transfer="item"
						side="outgoing"
						:can-answer="canAnswer"
						:can-cancel="canCancel"
						:can-complete="canAnswer"
						@cancel="cancel(item.siteId, item.id)"
					/>
					<p
						v-if="data.outgoing.length === 0"
						class="text-sm text-muted"
					>
						No site is moving out of this organization.
					</p>
				</section>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Sites Moving In</h2>
					<AgencyTransferFlow
						v-for="item in data.incoming"
						:key="item.id"
						:transfer="item"
						side="incoming"
						:can-answer="canAnswer"
						:can-cancel="canCancel"
						:can-complete="canAnswer"
						@accept="answer('accept', item.id)"
						@decline="answer('decline', item.id)"
						@complete="answer('complete', item.id)"
					/>
					<p
						v-if="data.incoming.length === 0"
						class="text-sm text-muted"
					>
						No site is moving into this organization.
					</p>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full" />
		</template>
	</ClientOnly>
</template>
