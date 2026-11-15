<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import type { BillingAddOn, PlanEntitlement } from '~/stores/billing';

const props = defineProps<{
	addOns: BillingAddOn[];
	entitlement: PlanEntitlement;
	interval: Interval;
	canBuy: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{
	subscribe: [addOnId: string, quantity: number];
	change: [addOnId: string, quantity: number];
	pack: [addOnId: string, units: number];
}>();

// an add-on is shown when it runs on the organization's plane and names its plan, or names none
const offered = computed(() =>
	props.addOns
		.filter(
			(addOn) =>
				addOn.planes.includes(props.entitlement.plane) &&
				(addOn.requires === null || addOn.requires.includes(props.entitlement.planId))
		)
		.sort((a, b) => Number(b.available) - Number(a.available))
);

const held = (id: string) => props.entitlement.addOns.find((item) => item.id === id)?.quantity ?? 0;
</script>

<template>
	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold text-highlighted">Add-Ons</h2>
			<p class="max-w-prose text-sm text-muted">
				Add what you need on top of your plan. A subscription renews with your plan and its
				quantity can change at any time. A one-time pack is paid once.
			</p>
		</div>

		<UiEmptyState
			v-if="offered.length === 0"
			icon="i-lucide-package-plus"
			title="No Add-Ons for This Plan"
			text="Add-ons appear here when your plan can use them."
		/>
		<ul
			v-else
			class="divide-y divide-default border-y border-default"
		>
			<BillingAddonRow
				v-for="addOn in offered"
				:key="addOn.id"
				:add-on="addOn"
				:held="held(addOn.id)"
				:interval="interval"
				:can-buy="canBuy"
				:busy="busy"
				@subscribe="(quantity) => emit('subscribe', addOn.id, quantity)"
				@change="(quantity) => emit('change', addOn.id, quantity)"
				@pack="(units) => emit('pack', addOn.id, units)"
			/>
		</ul>
	</section>
</template>
