<script setup lang="ts">
import { allowedOverageDollars, capViews, type Money, type UnitRate } from '~/shared/budget-rules';

const props = defineProps<{
	// the percent on screen, which may not be saved yet
	percent: number;
	allowanceViews: number | null;
	// the saved percent and the dollar figure the server computed for it
	savedPercent: number | null;
	saved: Money | null;
	// false until overage billing is switched on: nothing is billed, whatever the rate says
	overageBilled: boolean;
}>();

// the server prices the saved percent; the unit rate is that figure divided back out, so a
// draft percent gets the same rate without a second call
const rate = computed<UnitRate>(() => {
	const unknown: UnitRate = { perMillion: null, unreviewed: true };
	const { saved, savedPercent, allowanceViews } = props;
	if (saved === null || savedPercent === null || allowanceViews === null) return unknown;
	if (saved.kind !== 'dollars') return unknown;
	const cap = capViews(allowanceViews, savedPercent);
	if (cap <= 0) return unknown;
	return { perMillion: (saved.dollars * 1_000_000) / cap, unreviewed: false };
});

const money = computed<Money | null>(() => {
	if (props.allowanceViews === null) return null;
	return allowedOverageDollars(props.percent, props.allowanceViews, rate.value);
});

const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
</script>

<template>
	<p
		class="text-sm text-muted"
		aria-live="polite"
	>
		<template v-if="overageBilled && money?.kind === 'dollars'">
			At the current unit rate, this budget allows up to
			<span class="font-medium text-default">{{ formatted.format(money.dollars) }}</span>
			of overage a month.
		</template>
		<template v-else>Not billed yet.</template>
	</p>
</template>
