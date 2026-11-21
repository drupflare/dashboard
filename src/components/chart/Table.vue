<script setup lang="ts">
import { ACCOUNTING_LABELS, type Accounting, type UsageTableRow } from '~/shared/usage';

defineProps<{ caption: string; rows: UsageTableRow[] }>();

const icons: Record<Accounting, string> = {
	exact: 'i-lucide-check',
	estimated: 'i-lucide-triangle-alert',
	unaccounted: 'i-lucide-circle-slash'
};

const count = (value: number) => value.toLocaleString('en-US');
</script>

<template>
	<div
		class="overflow-x-auto"
		tabindex="0"
		role="region"
		aria-label="Chart Data"
	>
		<table class="w-full text-left text-sm">
			<caption class="mb-2 text-left text-muted">
				{{
					caption
				}}
			</caption>
			<thead class="border-b border-default text-muted">
				<tr>
					<th
						scope="col"
						class="py-2 pr-4 font-medium"
					>
						Period
					</th>
					<th
						scope="col"
						class="py-2 pr-4 text-right font-medium"
					>
						Views
					</th>
					<th
						scope="col"
						class="py-2 pr-4 text-right font-medium"
					>
						Lower Bound
					</th>
					<th
						scope="col"
						class="py-2 font-medium"
					>
						Accounting
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.label"
					class="border-b border-default"
				>
					<th
						scope="row"
						class="py-2 pr-4 font-normal text-default"
					>
						{{ row.label }}
					</th>
					<td class="py-2 pr-4 text-right tabular-nums">{{ count(row.views) }}</td>
					<td class="py-2 pr-4 text-right tabular-nums">{{ count(row.lowerBound) }}</td>
					<td class="py-2">
						<span class="inline-flex items-center gap-1.5">
							<UIcon
								:name="icons[row.state]"
								aria-hidden="true"
							/>
							{{ ACCOUNTING_LABELS[row.state] }}
						</span>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
