<script setup lang="ts">
import type { Interval, Plane } from '~/shared/plans';
import type { BillingPlan } from '~/stores/billing';

const props = defineProps<{
	plans: BillingPlan[];
	currentPlanId: string;
	interval: Interval;
	canBuy: boolean;
	// the organization already pays for something, so a change goes through the portal
	subscribed: boolean;
	portal: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ subscribe: [planId: string, interval: Interval] }>();

const GROUPS: { plane: Plane; title: string; text: string }[] = [
	{
		plane: 'managed',
		title: 'Managed',
		text: 'We host your sites on our Cloudflare account.'
	},
	{
		plane: 'self-managed',
		title: 'Self-Managed',
		text: 'We manage sites on your own Cloudflare account. You pay Cloudflare for what the sites use.'
	},
	{
		plane: 'self-hosted',
		title: 'Self-Hosted',
		text: 'Run Drupflare on a server you own. Nothing is charged for linking it.'
	}
];

const canSubscribe = computed(() => props.canBuy && !props.subscribed);

// the group the organization is on comes first
const groups = computed(() => {
	const currentPlane = props.plans.find((plan) => plan.id === props.currentPlanId)?.plane;
	return GROUPS.map((group) => ({
		...group,
		plans: props.plans.filter((plan) => plan.plane === group.plane)
	}))
		.filter((group) => group.plans.length > 0)
		.sort((a, b) => Number(b.plane === currentPlane) - Number(a.plane === currentPlane));
});
</script>

<template>
	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold text-highlighted">Plans</h2>
			<p
				v-if="subscribed"
				class="max-w-prose text-sm text-muted"
			>
				<template v-if="portal">
					This organization already has a subscription. Use Manage Billing to change it.
				</template>
				<template v-else>
					This plan is not billed through the dashboard, so it cannot be changed here.
				</template>
			</p>
		</div>

		<UiEmptyState
			v-if="plans.length === 0"
			icon="i-lucide-receipt"
			title="No Plans Yet"
			text="Plans appear here once they are published."
		/>
		<div
			v-else
			class="flex flex-col gap-6"
		>
			<div
				v-for="group in groups"
				:key="group.plane"
				class="flex flex-col"
			>
				<h3 class="font-medium text-highlighted">{{ group.title }}</h3>
				<p class="max-w-prose text-sm text-muted">{{ group.text }}</p>
				<ul class="mt-2 divide-y divide-default border-y border-default">
					<BillingPlanRow
						v-for="plan in group.plans"
						:key="plan.id"
						:plan="plan"
						:current="plan.id === currentPlanId"
						:interval="interval"
						:can-subscribe="canSubscribe"
						:busy="busy"
						@subscribe="emit('subscribe', plan.id, interval)"
					/>
				</ul>
			</div>
		</div>
	</section>
</template>
