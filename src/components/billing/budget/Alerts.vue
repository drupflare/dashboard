<script setup lang="ts">
import { budgetNinetyShown } from '~/shared/budget-rules';
import type { BudgetView } from '~/shared/budgets';

const props = defineProps<{ reply: BudgetView }>();

type AlertKey = BudgetView['alertsSent'][number];

const rows = computed(() => {
	const all: { key: AlertKey; text: string }[] = [
		{ key: 'allowance-75', text: 'At 75 percent of included views' },
		{ key: 'allowance-90', text: 'At 90 percent of included views' },
		{ key: 'allowance-100', text: 'At 100 percent of included views' },
		{ key: 'allowance-250', text: 'At 250 percent of included views' }
	];
	if (props.reply.percent !== null && budgetNinetyShown(props.reply.percent)) {
		all.push({ key: 'budget-90', text: 'At 90 percent of the budget' });
	}
	if (props.reply.enforcement === 'block') {
		all.push({ key: 'blocked', text: 'When the site stops at the budget' });
	}
	return all.map((row) => ({
		...row,
		sent: props.reply.alertsSent.includes(row.key)
	}));
});
</script>

<template>
	<section class="flex flex-col gap-3">
		<h3 class="text-base font-semibold text-highlighted">Alerts This Month</h3>
		<ul class="divide-y divide-default border-y border-default">
			<li
				v-for="row in rows"
				:key="row.key"
				class="flex items-center justify-between gap-4 py-3 text-sm"
			>
				<span class="text-default">{{ row.text }}</span>
				<span
					class="flex shrink-0 items-center gap-1.5"
					:class="row.sent ? 'text-default' : 'text-muted'"
				>
					<UIcon
						:name="row.sent ? 'i-lucide-bell-ring' : 'i-lucide-bell'"
						class="size-4"
						aria-hidden="true"
					/>
					{{ row.sent ? 'Sent' : 'Not sent yet' }}
				</span>
			</li>
		</ul>
	</section>
</template>
