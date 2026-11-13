<script setup lang="ts">
import { ROW_CLASSES } from '@contracts/estate';
import { CLASS_LABELS, type AssessmentView } from '~/shared/estate-view';

defineProps<{ classes: AssessmentView['classes'] }>();
</script>

<template>
	<div class="overflow-x-auto rounded-lg border border-default">
		<table class="w-full text-left text-sm">
			<caption class="sr-only">
				Sites counted by class
			</caption>
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Class
					</th>
					<th
						scope="col"
						class="px-4 py-3 text-right font-medium"
					>
						Sites
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="rowClass in ROW_CLASSES"
					:key="rowClass"
					class="border-t border-default"
				>
					<td class="px-4 py-3 font-medium text-highlighted">
						{{ CLASS_LABELS[rowClass] }}
					</td>
					<td class="px-4 py-3 text-right tabular-nums">{{ classes[rowClass] }}</td>
				</tr>
				<tr class="border-t border-default">
					<td class="px-4 py-3 font-medium text-highlighted">Total</td>
					<td class="px-4 py-3 text-right tabular-nums">
						{{ ROW_CLASSES.reduce((sum, rowClass) => sum + classes[rowClass], 0) }}
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
