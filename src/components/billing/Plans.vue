<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import type { BillingPlan } from '~/stores/billing';

const props = defineProps<{
	plans: BillingPlan[];
	canBuy: boolean;
	subscribed: boolean;
	// the organization can open the billing portal, so a change goes through it
	portal: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ subscribe: [planId: string, interval: Interval] }>();

const canSubscribe = computed(() => props.canBuy && !props.subscribed);
</script>

<template>
	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold text-highlighted">Plans</h2>
			<p
				v-if="subscribed"
				class="text-sm text-muted"
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
			class="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
		>
			<BillingPlan
				v-for="plan in plans"
				:key="plan.id"
				:plan="plan"
				:can-subscribe="canSubscribe"
				:busy="busy"
				@subscribe="(interval) => emit('subscribe', plan.id, interval)"
			/>
		</div>
	</section>
</template>
