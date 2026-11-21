<script setup lang="ts">
import type { LadderRow } from '~/stores/admin-ladder';

defineProps<{ rows: LadderRow[] }>();
</script>

<template>
	<div
		class="overflow-x-auto rounded-lg border border-default"
		tabindex="0"
		role="region"
		aria-label="Repair Catalogue"
	>
		<table class="w-full text-left text-sm">
			<caption class="sr-only">
				Repair Catalogue
			</caption>
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Source
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Severity
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Handle
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Automation
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Runs Today
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="row in rows"
					:key="row.repairId"
					class="border-t border-default"
				>
					<td class="px-4 py-3">
						<span class="font-medium">{{ row.repairId }}</span>
						<span class="block text-xs text-muted">{{ row.source }}</span>
					</td>
					<td class="px-4 py-3">{{ row.severity }}</td>
					<td class="px-4 py-3">
						<code>{{ row.handle }}</code>
					</td>
					<td class="px-4 py-3">{{ row.automation }}</td>
					<td class="px-4 py-3">
						<span
							v-if="row.canRunToday"
							class="inline-flex items-center gap-1.5 text-leaf-700 dark:text-leaf-300"
						>
							<UIcon
								name="i-lucide-circle-check"
								class="size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>Yes</span>
						</span>
						<span
							v-else
							class="inline-flex items-center gap-1.5 text-muted"
						>
							<UIcon
								name="i-lucide-ban"
								class="size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>{{ row.reason }}</span>
						</span>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
