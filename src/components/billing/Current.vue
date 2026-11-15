<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import { formatCount, formatDollars, formatHours } from '~/shared/utils/format';
import type { BillingAddOn, BillingPlan, PlanEntitlement } from '~/stores/billing';

const props = defineProps<{
	plan: BillingPlan | undefined;
	entitlement: PlanEntitlement;
	addOns: BillingAddOn[];
	interval: Interval;
	// the organization has a billing account, so the portal can open
	subscribed: boolean;
	canPortal: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ manage: [] }>();

const NOT_STATED = 'Not Stated';

const PLANE_LABELS = {
	managed: 'Managed',
	'self-managed': 'Self-Managed',
	'self-hosted': 'Self-Hosted'
};

const SUPPORT_LABELS: Record<string, string> = {
	community: 'Community',
	core: 'Core',
	business: 'Business',
	critical: '24/7 Critical'
};

const count = (value: number | null) => (value === null ? NOT_STATED : formatCount(value));
const gigabytes = (value: number | null) => (value === null ? NOT_STATED : `${value} GB`);
const hours = (value: number | null) => (value === null ? NOT_STATED : formatHours(value));

const price = computed(() => {
	const value = props.interval === 'month' ? props.plan?.monthly : props.plan?.annual;
	if (typeof value !== 'number') return null;
	if (value === 0) return 'Free';
	return `${formatDollars(value)} a ${props.interval}`;
});

const support = computed(() => {
	const level = SUPPORT_LABELS[props.entitlement.support] ?? props.entitlement.support;
	const included = props.entitlement.supportHoursPerYear;
	return included === null || included === 0
		? level
		: `${level}, ${formatHours(included)} a year`;
});

const rows = computed(() => [
	{
		label: 'Sites',
		value: props.entitlement.sites === null ? NOT_STATED : props.entitlement.sites
	},
	{ label: 'Views a Month', value: count(props.entitlement.views) },
	{ label: 'Site Storage', value: gigabytes(props.entitlement.storageGb) },
	{ label: 'Database Writes a Month', value: count(props.entitlement.writes) },
	{ label: 'Backup Space', value: gigabytes(props.entitlement.backupGb) },
	{ label: 'Emails a Month', value: count(props.entitlement.mailSends) },
	{ label: 'Container Time a Month', value: hours(props.entitlement.containerHours) },
	{ label: 'Private Site Invitees', value: count(props.entitlement.invitees) },
	{ label: 'Support', value: support.value }
]);

const hostedElsewhere = computed(() => props.entitlement.plane !== 'managed');

const bought = computed(() =>
	Object.entries(props.entitlement.credits ?? {}).map(([meter, units]) => ({
		meter,
		units,
		name: props.addOns.find((addOn) => addOn.meter === meter)?.name ?? 'Other'
	}))
);
</script>

<template>
	<section class="flex flex-col gap-5">
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h2 class="text-sm font-medium text-muted">Your Plan</h2>
				<p class="text-2xl font-bold text-highlighted">
					{{ plan?.name ?? 'Plan Not Listed' }}
				</p>
				<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
					<span>{{ PLANE_LABELS[entitlement.plane] }}</span>
					<span
						v-if="price"
						class="tabular-nums text-highlighted"
						>{{ price }}</span
					>
					<UBadge
						v-if="plan?.unreviewed"
						color="warning"
						variant="subtle"
						size="sm"
						>Unreviewed Price</UBadge
					>
				</p>
			</div>
			<UButton
				v-if="subscribed && canPortal"
				:loading="busy === 'portal'"
				:disabled="busy !== null"
				@click="emit('manage')"
			>
				Manage Billing
			</UButton>
		</div>

		<p
			v-if="hostedElsewhere"
			class="max-w-prose text-sm text-muted"
		>
			Sites on your own Cloudflare account or server are not counted. These limits apply to
			sites we host for you.
		</p>

		<dl class="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
			<div
				v-for="row in rows"
				:key="row.label"
				class="flex items-baseline justify-between gap-4 border-b border-default pb-2"
			>
				<dt class="text-muted">{{ row.label }}</dt>
				<dd class="tabular-nums text-highlighted">{{ row.value }}</dd>
			</div>
		</dl>

		<div
			v-if="bought.length"
			class="flex flex-col gap-1 text-sm"
		>
			<h3 class="font-medium text-highlighted">Packs You Bought</h3>
			<ul class="flex flex-col gap-1 text-muted">
				<li
					v-for="pack in bought"
					:key="pack.meter"
				>
					{{ pack.name }}:
					<span class="tabular-nums text-highlighted">{{ pack.units }}</span>
				</li>
			</ul>
		</div>

		<p
			v-if="!canPortal"
			class="text-sm text-muted"
		>
			Only organization owners and billing members can change billing.
		</p>
	</section>
</template>
