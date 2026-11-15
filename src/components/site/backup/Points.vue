<script setup lang="ts">
import type { RestoreLayerOffer, RestorePoint } from '~/shared/restore-points';

const props = defineProps<{ points: RestorePoint[]; layers: RestoreLayerOffer[] }>();

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function when(value: string): string {
	return dateFormat.format(new Date(value));
}
</script>

<template>
	<div class="flex flex-col gap-3">
		<p class="text-sm text-muted">
			A copy counts as verified only after a test restore passes.
		</p>
		<div class="overflow-x-auto rounded-lg border border-default">
			<table class="w-full text-left text-sm">
				<caption class="sr-only">
					Restore Points of This Site, Newest First
				</caption>
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Type
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Created
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Restores
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Does Not Restore
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Verified
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="point in points"
						:key="point.id"
						class="border-t border-default"
					>
						<td class="px-4 py-3">Saved Copy</td>
						<td class="px-4 py-3">
							<time :datetime="point.createdAt">{{ when(point.createdAt) }}</time>
						</td>
						<td class="px-4 py-3">
							<ul class="list-inside list-disc">
								<li
									v-for="item in point.moves"
									:key="item"
								>
									{{ item }}
								</li>
							</ul>
						</td>
						<td class="px-4 py-3">
							<ul class="list-inside list-disc">
								<li
									v-for="item in point.doesNotMove"
									:key="item"
								>
									{{ item }}
								</li>
							</ul>
						</td>
						<td class="px-4 py-3">
							<span
								v-if="point.verified"
								class="inline-flex items-center gap-1.5 text-leaf-700 dark:text-leaf-300"
							>
								<UIcon
									name="i-lucide-circle-check"
									class="size-4 shrink-0"
									aria-hidden="true"
								/>
								<span>Verified</span>
							</span>
							<span
								v-else
								class="inline-flex items-center gap-1.5 text-muted"
							>
								<UIcon
									name="i-lucide-clock"
									class="size-4 shrink-0"
									aria-hidden="true"
								/>
								<span>Not Yet Verified</span>
							</span>
						</td>
					</tr>
					<tr
						v-for="layer in layers"
						:key="layer.layer"
						class="border-t border-default"
					>
						<td class="px-4 py-3">Point in Time</td>
						<td class="px-4 py-3">Last {{ layer.windowDays }} days</td>
						<td class="px-4 py-3">
							<ul class="list-inside list-disc">
								<li
									v-for="item in layer.moves"
									:key="item"
								>
									{{ item }}
								</li>
							</ul>
						</td>
						<td class="px-4 py-3">
							<ul class="list-inside list-disc">
								<li
									v-for="item in layer.doesNotMove"
									:key="item"
								>
									{{ item }}
								</li>
							</ul>
						</td>
						<td class="px-4 py-3 text-muted">Not Yet Verified</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
