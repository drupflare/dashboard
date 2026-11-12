<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import type { BillingPlan } from '~/stores/billing';

const props = defineProps<{
	plan: BillingPlan;
	canSubscribe: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ subscribe: [interval: Interval] }>();

const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 0,
	maximumFractionDigits: 2
});

// the API omits a price key for viewers who may not see it; a null value is an unknown price
const monthly = computed(() =>
	typeof props.plan.monthly === 'number' ? props.plan.monthly : null
);
const annual = computed(() => (typeof props.plan.annual === 'number' ? props.plan.annual : null));
const priced = computed(() => monthly.value !== null || annual.value !== null);
const sellable = computed(
	() => props.canSubscribe && props.plan.kind === 'managed' && !props.plan.disabled
);

const busyKey = (interval: Interval) => `${props.plan.id}:${interval}`;
</script>

<template>
	<article
		class="flex flex-col gap-4 rounded-lg border border-default p-5"
		:class="plan.disabled && 'opacity-60'"
	>
		<header class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-2">
				<h3 class="text-lg font-semibold text-highlighted">{{ plan.name }}</h3>
				<span
					v-if="plan.unreviewed"
					class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
				>
					Unreviewed
				</span>
				<span
					v-if="plan.disabled"
					class="rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted"
				>
					Coming Soon
				</span>
			</div>
		</header>

		<p
			v-if="!priced"
			class="text-sm text-muted"
		>
			Pricing is not published yet.
		</p>
		<ul
			v-else
			class="flex flex-col gap-1 text-highlighted"
		>
			<li v-if="monthly !== null">{{ money.format(monthly) }} a month</li>
			<li v-if="annual !== null">{{ money.format(annual) }} a year</li>
		</ul>

		<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
			<dt class="text-muted">Sites</dt>
			<dd class="text-highlighted">{{ plan.sites ?? 'Not Stated' }}</dd>
			<dt class="text-muted">Views</dt>
			<dd class="text-highlighted">{{ plan.views ?? 'Not Stated' }}</dd>
			<dt class="text-muted">Support</dt>
			<dd class="text-highlighted">{{ plan.support }}</dd>
		</dl>

		<p
			v-if="plan.disabled"
			class="text-sm text-muted"
		>
			This plan is coming soon.
		</p>
		<p
			v-else-if="plan.kind !== 'managed'"
			class="text-sm text-muted"
		>
			This plan is not sold online.
		</p>

		<div
			v-if="sellable && priced"
			class="mt-auto flex flex-wrap gap-2"
		>
			<UButton
				v-if="monthly !== null"
				:loading="busy === busyKey('month')"
				:disabled="busy !== null"
				@click="emit('subscribe', 'month')"
			>
				Subscribe Monthly
			</UButton>
			<UButton
				v-if="annual !== null"
				:loading="busy === busyKey('year')"
				:disabled="busy !== null"
				@click="emit('subscribe', 'year')"
			>
				Subscribe Annually
			</UButton>
		</div>
	</article>
</template>
