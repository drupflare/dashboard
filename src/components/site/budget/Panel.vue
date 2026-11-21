<script setup lang="ts">
import { useBudgetStore } from '~/stores/budget';
import { useOrgStore } from '~/stores/org';

const props = defineProps<{
	siteId: string;
	canManage: boolean;
}>();

const org = useOrgStore();
const budget = useBudgetStore();

const orgId = computed(() => org.current?.id ?? null);
const reply = computed(() => budget.sites.get(props.siteId));
const failure = computed(() => budget.siteError.get(props.siteId));
const ok = computed(() => (reply.value?.status === 'ok' ? reply.value : null));

// the organization budget is the ceiling; when it cannot be read the server still refuses a higher site budget
const ceiling = computed(() => {
	const orgReply = orgId.value ? budget.org.get(orgId.value) : undefined;
	return orgReply?.status === 'ok' ? orgReply.percent : null;
});

const view = computed(() => {
	if (failure.value) return 'error';
	if (reply.value === undefined) return 'loading';
	if (reply.value === null) return 'absent';
	if (reply.value.status === 'not_applicable') return 'free';
	return 'ready';
});

function load(): void {
	if (!orgId.value) return;
	void budget.loadSite(orgId.value, props.siteId);
	void budget.loadOrg(orgId.value);
}

watch(orgId, load, { immediate: true });
</script>

<template>
	<section class="flex max-w-4xl flex-col gap-6">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold text-highlighted">Budget</h2>
			<p class="max-w-prose text-sm text-muted">
				The budget caps what this site can spend on usage in a month. The organization
				budget covers every site.
			</p>
		</div>

		<UiErrorState
			v-if="view === 'error'"
			title="Could Not Load the Site Budget"
			:text="failure?.message"
			:request-id="failure?.requestId"
		>
			<UButton
				color="neutral"
				@click="orgId && budget.refreshSite(orgId, siteId)"
				>Try Again</UButton
			>
		</UiErrorState>

		<UiSkeletonTable
			v-else-if="view === 'loading'"
			label="Loading site budget"
		/>

		<UiEmptyState
			v-else-if="view === 'absent'"
			icon="i-lucide-gauge"
			title="No Budget Found"
			text="This site has no budget record yet."
		/>

		<UiEmptyState
			v-else-if="view === 'free'"
			icon="i-lucide-wallet"
			title="Budgets Start on a Paid Plan"
			text="Free sites have no spend budget and stay within the free-tier limits. Add a payment method to pay as you go with the default budget."
		/>

		<BillingBudgetForm
			v-else-if="ok && orgId"
			scope="site"
			:org-id="orgId"
			:site-id="siteId"
			:reply="ok"
			:ceiling="ceiling"
			:can-manage="canManage"
		/>
	</section>
</template>
