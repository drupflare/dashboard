<script setup lang="ts">
import type { BudgetView } from '~/shared/budgets';

const props = defineProps<{ reply: BudgetView }>();

const status = computed(() => {
	if (props.reply.state === 'over-budget') {
		return { icon: 'i-lucide-octagon-x', text: 'Stopped at the budget' };
	}
	if (props.reply.state === 'would-block') {
		return { icon: 'i-lucide-flask-conical', text: 'Would stop (testing mode)' };
	}
	return { icon: 'i-lucide-circle-check', text: 'Running' };
});

const accounting = computed(() => {
	if (props.reply.accounting === 'unavailable') {
		return {
			icon: 'i-lucide-circle-help',
			text: 'Unaccounted: the view count is not available yet.'
		};
	}
	return {
		icon: 'i-lucide-chart-no-axes-column',
		text: 'Estimated: the count is a lower bound and can miss the last few seconds of traffic.'
	};
});

const cap = computed(() => {
	const { allowanceViews, percent } = props.reply;
	if (allowanceViews === null || percent === null) return null;
	return (allowanceViews * percent) / 100;
});

// one scale from zero to the largest figure, so the bar starts at a zero baseline
const scale = computed(() => {
	const values = [props.reply.viewsLowerBound, props.reply.allowanceViews, cap.value];
	return Math.max(0, ...values.filter((v): v is number => v !== null));
});

const pct = (value: number | null) =>
	value === null || scale.value === 0 ? null : `${(value / scale.value) * 100}%`;

const rows = computed(() => [
	{ label: 'Views Counted So Far', value: props.reply.viewsLowerBound },
	{ label: 'Included Views', value: props.reply.allowanceViews },
	{ label: 'Budget Cap', value: cap.value }
]);

const format = new Intl.NumberFormat('en-US');
</script>

<template>
	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-2">
			<p
				class="flex items-center gap-2 text-sm font-medium text-default"
				role="status"
			>
				<UIcon
					:name="status.icon"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ status.text }}</span>
			</p>
			<p class="flex items-start gap-2 text-sm text-muted">
				<UIcon
					:name="accounting.icon"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ accounting.text }}</span>
			</p>
		</div>

		<div
			v-if="reply.viewsLowerBound !== null && scale > 0"
			class="relative h-3 w-full rounded-full border border-accented bg-elevated"
			aria-hidden="true"
		>
			<div
				class="h-full rounded-full bg-brand-600"
				:style="{ width: pct(reply.viewsLowerBound) ?? '0%' }"
			/>
			<div
				v-if="pct(reply.allowanceViews)"
				class="absolute inset-y-0 w-px bg-inverted"
				:style="{ left: pct(reply.allowanceViews) ?? '0%' }"
			/>
			<div
				v-if="pct(cap)"
				class="absolute inset-y-0 w-px bg-inverted"
				:style="{ left: pct(cap) ?? '0%' }"
			/>
		</div>

		<table class="w-full max-w-md text-sm">
			<caption class="sr-only">
				Usage against the allowance and the budget
			</caption>
			<tbody class="divide-y divide-default">
				<tr
					v-for="row in rows"
					:key="row.label"
				>
					<th
						scope="row"
						class="py-2 text-left font-medium text-default"
					>
						{{ row.label }}
					</th>
					<td class="py-2 text-right text-muted tabular-nums">
						{{ row.value === null ? 'Not available' : format.format(row.value) }}
					</td>
				</tr>
			</tbody>
		</table>
	</section>
</template>
