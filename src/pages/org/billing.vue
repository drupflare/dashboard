<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import type { Interval } from '~/shared/plans';
import { FREE_PLAN_ID, useBillingStore } from '~/stores/billing';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Billing' });

const session = useSessionStore();
const org = useOrgStore();
const billing = useBillingStore();

const orgId = computed(() => org.current?.id ?? null);
const actions = computed<readonly string[]>(() => {
	const role = org.current?.role;
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
});
const canBuy = computed(() => actions.value.includes('billing.manage'));
const canPortal = computed(() => actions.value.includes('billing.portal'));

const entitlement = computed(() =>
	orgId.value ? billing.entitlements.get(orgId.value) : undefined
);
const plan = computed(() =>
	entitlement.value
		? billing.plans?.find((item) => item.id === entitlement.value?.planId)
		: undefined
);
const paidPlan = computed(() => {
	const current = entitlement.value;
	return !!current && current.planId !== FREE_PLAN_ID;
});
const subscribed = computed(() => paidPlan.value && entitlement.value?.billingAccount === true);
const addOnNames = computed(() =>
	(entitlement.value?.addOns ?? []).flatMap((id) => {
		const name = billing.plans?.find((item) => item.id === id)?.name;
		return name ? [name] : [];
	})
);

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (billing.entitlementError) return 'plan-error';
	if (billing.plansError) return 'plans-error';
	if (entitlement.value === undefined || billing.plans === undefined) return 'loading';
	if (entitlement.value === null) return 'no-plan';
	return 'ready';
});

const actionError = ref<ApiClientError | null>(null);
// the key of the request in flight; one at a time, so a double click cannot start two
const busy = ref<string | null>(null);
// the retry to run once a fresh sign-in is confirmed
const waiting = ref<(() => Promise<void>) | null>(null);

function load(): void {
	void billing.loadPlans();
	if (orgId.value) void billing.loadEntitlement(orgId.value);
}

onMounted(load);
watch(orgId, (id) => {
	if (id) void billing.loadEntitlement(id);
});

function fresh(): boolean {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
}

async function guarded(key: string, run: () => Promise<void>): Promise<void> {
	actionError.value = null;
	// a stale local sign-in time or a server step-up denial both wait for the code
	if (!fresh()) {
		waiting.value = () => guarded(key, run);
		return;
	}
	busy.value = key;
	try {
		await run();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') waiting.value = () => guarded(key, run);
		else actionError.value = failure;
	} finally {
		busy.value = null;
	}
}

function stepUpDone(): void {
	const retry = waiting.value;
	waiting.value = null;
	if (retry) void retry();
}

function subscribe(planId: string, interval: Interval): void {
	const id = orgId.value;
	if (!id) return;
	void guarded(`${planId}:${interval}`, async () => {
		const { url } = await billing.checkout(id, planId, interval);
		await navigateTo(url, { external: true });
	});
}

function manage(): void {
	const id = orgId.value;
	if (!id) return;
	void guarded('portal', async () => {
		const { url } = await billing.portal(id);
		await navigateTo(url, { external: true });
	});
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Billing"
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
				v-else-if="view === 'plan-error'"
				title="Could Not Load Your Plan"
				:text="billing.entitlementError?.message"
				:request-id="billing.entitlementError?.requestId"
			>
				<UButton
					color="neutral"
					@click="load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiErrorState
				v-else-if="view === 'plans-error'"
				title="Could Not Load Plans"
				:text="billing.plansError?.message"
				:request-id="billing.plansError?.requestId"
			>
				<UButton
					color="neutral"
					@click="load()"
					>Try Again</UButton
				>
			</UiErrorState>

			<UiSkeletonTable
				v-else-if="view === 'loading'"
				label="Loading billing"
			/>

			<UiEmptyState
				v-else-if="view === 'no-plan'"
				icon="i-lucide-receipt"
				title="No Plan Found"
				text="This organization's plan could not be found."
			/>

			<template v-else>
				<UiEmptyState
					v-if="actionError?.code === 'not_built'"
					icon="i-lucide-circle-slash"
					title="Billing Is Not Set Up Yet"
					text="Nothing is wrong with the site. Billing is not turned on for this dashboard yet."
				/>
				<UiErrorState
					v-else-if="actionError"
					title="Billing Request Failed"
					:text="actionError.message"
					:request-id="actionError.requestId"
				/>

				<AccountStepUp
					v-if="waiting"
					@done="stepUpDone()"
					@cancel="waiting = null"
				/>

				<BillingStatus
					v-if="entitlement"
					:plan-name="plan?.name ?? null"
					:entitlement="entitlement"
					:add-on-names="addOnNames"
					:subscribed="subscribed"
					:can-portal="canPortal"
					:busy="busy"
					@manage="manage()"
				/>

				<BillingPlans
					:plans="billing.plans ?? []"
					:can-buy="canBuy"
					:subscribed="paidPlan"
					:portal="subscribed"
					:busy="busy"
					@subscribe="subscribe"
				/>
			</template>
		</div>
	</ClientOnly>
</template>
