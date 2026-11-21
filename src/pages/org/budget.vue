<script setup lang="ts">
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import { useBudgetStore } from '~/stores/budget';
import { useOrgStore } from '~/stores/org';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Budget' });

const org = useOrgStore();
const budget = useBudgetStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canManage = computed(() => actions.value.includes('billing.manage'));

const reply = computed(() => (orgId.value ? budget.org.get(orgId.value) : undefined));
const failure = computed(() => (orgId.value ? budget.orgError.get(orgId.value) : undefined));
const ok = computed(() => (reply.value?.status === 'ok' ? reply.value : null));

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (failure.value) return 'error';
	if (reply.value === undefined) return 'loading';
	if (reply.value === null) return 'absent';
	if (reply.value.status === 'not_applicable') return 'free';
	return 'ready';
});

function load(): void {
	if (orgId.value) void budget.loadOrg(orgId.value);
}

watch(orgId, load, { immediate: true });
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-4xl flex-col gap-10">
			<UiPageHeader
				title="Budget"
				:text="org.current?.name"
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

			<UiErrorState
				v-else-if="view === 'error'"
				title="Could Not Load the Budget"
				:text="failure?.message"
				:request-id="failure?.requestId"
			>
				<UButton
					color="neutral"
					@click="orgId && budget.refreshOrg(orgId)"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading budget"
			/>

			<UiEmptyState
				v-else-if="view === 'absent'"
				icon="i-lucide-gauge"
				title="No Budget Found"
				text="This organization has no budget record yet."
			/>

			<UiEmptyState
				v-else-if="view === 'free'"
				icon="i-lucide-wallet"
				title="Budgets Start on a Paid Plan"
				text="Free organizations have no spend budget and stay within the free-tier limits. Add a payment method to pay as you go with the default budget."
			/>

			<template v-else-if="view === 'ready' && ok && orgId">
				<p class="max-w-prose text-sm text-muted">
					The budget caps what this organization can spend on usage in a month. A site
					budget cannot be higher than this one.
				</p>
				<BillingBudgetForm
					scope="org"
					:org-id="orgId"
					:reply="ok"
					:ceiling="null"
					:can-manage="canManage"
				/>
			</template>
		</div>
		<template #fallback>
			<UiSkeletonTable label="Loading budget" />
		</template>
	</ClientOnly>
</template>
