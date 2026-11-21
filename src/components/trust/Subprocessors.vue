<script setup lang="ts">
import type { Subprocessor } from '~/shared/trust';

defineProps<{ items: readonly Subprocessor[] }>();
</script>

<template>
	<div
		class="overflow-x-auto rounded-lg border border-default"
		tabindex="0"
		role="region"
		aria-label="Subprocessors"
	>
		<table class="w-full min-w-[32rem] text-left text-sm">
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Subprocessor
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						What It Does
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Data It Handles
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-default">
				<tr
					v-for="item in items"
					:key="item.name"
				>
					<th
						scope="row"
						class="px-4 py-3 align-top font-medium text-highlighted"
					>
						{{ item.name }}
					</th>
					<td class="px-4 py-3 align-top text-default">{{ item.purpose }}</td>
					<td class="px-4 py-3 align-top text-default">{{ item.dataTouched }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
