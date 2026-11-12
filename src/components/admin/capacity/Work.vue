<script setup lang="ts">
import type { WorkView } from '~/shared/capacity';
import { operationTypeLabel } from '~/shared/operation-copy';

defineProps<{ view: WorkView }>();

const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
</script>

<template>
	<section
		class="flex max-w-3xl flex-col gap-3"
		aria-labelledby="capacity-work"
	>
		<h2
			id="capacity-work"
			class="text-lg font-semibold text-highlighted"
		>
			Work in Flight
		</h2>
		<dl class="grid max-w-md grid-cols-2 gap-y-2">
			<dt class="text-muted">Running Now</dt>
			<dd class="text-right font-semibold text-highlighted">{{ view.running }}</dd>
			<dt class="text-muted">Failed in the Last 24 Hours</dt>
			<dd class="text-right font-semibold text-highlighted">{{ view.failedLastDay }}</dd>
		</dl>
		<h3 class="font-semibold text-highlighted">Sites by State</h3>
		<p
			v-if="Object.keys(view.sites).length === 0"
			class="text-muted"
		>
			No sites yet.
		</p>
		<dl
			v-else
			class="grid max-w-md grid-cols-2 gap-y-2"
		>
			<template
				v-for="[state, count] in Object.entries(view.sites)"
				:key="state"
			>
				<dt class="text-muted">{{ state }}</dt>
				<dd class="text-right font-medium text-highlighted">{{ count }}</dd>
			</template>
		</dl>
		<h3 class="font-semibold text-highlighted">Recent Failures</h3>
		<p
			v-if="view.recentFailures.length === 0"
			class="text-muted"
		>
			No changes failed in the last 24 hours.
		</p>
		<div
			v-else
			class="overflow-x-auto rounded-lg border border-default"
		>
			<table class="w-full text-left text-sm">
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-4 py-3 font-medium whitespace-nowrap"
						>
							Change
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium whitespace-nowrap"
						>
							Reason
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium whitespace-nowrap"
						>
							When
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="failure in view.recentFailures"
						:key="failure.id"
						class="border-t border-default"
					>
						<td class="px-4 py-3 whitespace-nowrap text-highlighted">
							{{ operationTypeLabel(failure.type) }}
						</td>
						<td class="px-4 py-3 text-highlighted">{{ failure.reason ?? 'None' }}</td>
						<td class="px-4 py-3 whitespace-nowrap text-muted">
							{{ when(failure.at) }}
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>
</template>
