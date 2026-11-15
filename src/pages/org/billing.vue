<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { isOrgRole, ORG_ROLE_ACTIONS } from '~/shared/permissions';
import type { Interval } from '~/shared/plans';
import { FREE_PLAN_IDS, useBillingStore, type AddOnResult } from '~/stores/billing';
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
// a paid plan means a plan subscription exists, so a change goes through the portal; add-ons
// alone do not stop a plan purchase
const hasSubscription = computed(() => {
	const current = entitlement.value;
	if (!current) return false;
	return !FREE_PLAN_IDS.includes(current.planId);
});
const billingAccount = computed(() => entitlement.value?.billingAccount === true);

const view = computed(() => {
	if (org.error && !org.current) return 'org-error';
	if (org.items !== undefined && !org.current) return 'no-org';
	if (billing.entitlementError) return 'plan-error';
	if (billing.plansError) return 'plans-error';
	if (billing.addOnsError) return 'add-ons-error';
	if (
		entitlement.value === undefined ||
		billing.plans === undefined ||
		billing.addOns === undefined
	) {
		return 'loading';
	}
	if (entitlement.value === null) return 'no-plan';
	return 'ready';
});

const interval = ref<Interval>('month');
const actionError = ref<ApiClientError | null>(null);
// the key of the request in flight; one at a time, so a double click cannot start two
const busy = ref<string | null>(null);
// the retry to run once a fresh sign-in is confirmed
const waiting = ref<(() => Promise<void>) | null>(null);
const notice = ref<string | null>(null);
const checking = ref(false);
// the retry to run once the billing details are saved, and the parts the server said it lacks
const detailsRetry = ref<{ run: () => Promise<void>; missing: string[] } | null>(null);

function load(): void {
	void billing.loadPlans();
	void billing.loadAddOns();
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
		const details = failure.details as {
			requires?: string;
			reason?: string;
			missing?: string[];
		} | null;
		if (details?.requires === 'step-up') waiting.value = () => guarded(key, run);
		else if (details?.reason === 'billing_details_required') {
			detailsRetry.value = { run: () => guarded(key, run), missing: details.missing ?? [] };
		} else actionError.value = failure;
	} finally {
		busy.value = null;
	}
}

function detailsSaved(): void {
	const retry = detailsRetry.value;
	detailsRetry.value = null;
	if (retry) void retry.run();
}

function stepUpDone(): void {
	const retry = waiting.value;
	waiting.value = null;
	if (retry) void retry();
}

function subscribe(planId: string, chosen: Interval): void {
	const id = orgId.value;
	if (!id) return;
	void guarded(`${planId}:${chosen}`, async () => {
		await settle(await billing.checkout(id, planId, chosen));
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

async function settle(result: AddOnResult): Promise<void> {
	if ('url' in result) {
		await navigateTo(result.url, { external: true });
		return;
	}
	notice.value = 'Your change was sent. It shows here once your payment provider confirms it.';
}

function runAddOn(key: string, request: (id: string) => Promise<AddOnResult>): void {
	const id = orgId.value;
	if (!id) return;
	notice.value = null;
	void guarded(key, async () => settle(await request(id)));
}

function subscribeAddOn(addOn: string, quantity: number): void {
	runAddOn(`addon:${addOn}:sub`, (id) =>
		billing.buyAddOn(id, { mode: 'subscription', addOn, quantity, interval: interval.value })
	);
}

function changeAddOn(addOn: string, quantity: number): void {
	runAddOn(`addon:${addOn}:set`, (id) => billing.setAddOnQuantity(id, addOn, quantity));
}

function buyPack(addOn: string, units: number): void {
	runAddOn(`addon:${addOn}:pack`, (id) => billing.buyAddOn(id, { mode: 'pack', addOn, units }));
}

async function checkAgain(): Promise<void> {
	const id = orgId.value;
	if (!id) return;
	checking.value = true;
	actionError.value = null;
	try {
		await billing.refreshEntitlement(id);
		notice.value = null;
	} catch (cause) {
		actionError.value = toApiClientError(cause);
	} finally {
		checking.value = false;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-4xl flex-col gap-10">
			<UiPageHeader
				title="Billing"
				:text="org.current?.name"
			>
				<BillingInterval
					v-if="view === 'ready'"
					v-model="interval"
				/>
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

			<UiErrorState
				v-else-if="view === 'add-ons-error'"
				title="Could Not Load Add-Ons"
				:text="billing.addOnsError?.message"
				:request-id="billing.addOnsError?.requestId"
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

			<template v-else-if="entitlement">
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

				<BillingDetails
					v-if="detailsRetry && orgId"
					:org-id="orgId"
					:missing="detailsRetry.missing"
					@saved="detailsSaved()"
					@cancel="detailsRetry = null"
				/>

				<div
					v-if="notice"
					role="status"
					class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-default p-4 text-sm"
				>
					<p>{{ notice }}</p>
					<UButton
						color="neutral"
						variant="outline"
						:loading="checking"
						@click="checkAgain()"
					>
						Check Again
					</UButton>
				</div>

				<BillingCurrent
					:plan="plan"
					:entitlement="entitlement"
					:add-ons="billing.addOns ?? []"
					:interval="interval"
					:subscribed="billingAccount"
					:can-portal="canPortal"
					:busy="busy"
					@manage="manage()"
				/>

				<BillingAddOns
					:add-ons="billing.addOns ?? []"
					:entitlement="entitlement"
					:interval="interval"
					:can-buy="canBuy"
					:busy="busy"
					@subscribe="subscribeAddOn"
					@change="changeAddOn"
					@pack="buyPack"
				/>

				<BillingPlans
					:plans="billing.plans ?? []"
					:current-plan-id="entitlement.planId"
					:interval="interval"
					:can-buy="canBuy"
					:subscribed="hasSubscription"
					:portal="billingAccount"
					:busy="busy"
					@subscribe="subscribe"
				/>
			</template>
		</div>
		<template #fallback>
			<UiSkeletonTable label="Loading billing" />
		</template>
	</ClientOnly>
</template>
