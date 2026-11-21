<script setup lang="ts">
import type { CostCenterView, CostSite } from '~/shared/cost-centers';

const props = defineProps<{
	centers: CostCenterView[];
	sites: CostSite[];
	saving: boolean;
}>();

const emit = defineEmits<{
	assign: [siteId: string, costCenterId: string | null];
}>();

const unassigned = computed(() => props.sites.filter((site) => site.costCenterId === null));

const sitesIn = (centerId: string) => props.sites.filter((site) => site.costCenterId === centerId);

const selectClass =
	'rounded-md border border-default bg-default px-2 py-1 text-default focus-visible:outline-2 focus-visible:outline-primary';
</script>

<template>
	<div class="space-y-4">
		<section
			v-for="center in centers"
			:key="center.id"
			class="rounded-md border border-default p-4"
		>
			<h3 class="font-semibold text-default">{{ center.code }} {{ center.name }}</h3>
			<ul class="mt-2 space-y-2">
				<li
					v-for="site in sitesIn(center.id)"
					:key="site.id"
					class="flex items-center justify-between gap-3"
				>
					<span class="text-default">{{ site.name }}</span>
					<select
						:class="selectClass"
						:disabled="saving"
						:aria-label="`Cost center for ${site.name}`"
						:value="site.costCenterId ?? ''"
						@change="
							emit(
								'assign',
								site.id,
								($event.target as HTMLSelectElement).value || null
							)
						"
					>
						<option value="">No Cost Center</option>
						<option
							v-for="option in centers"
							:key="option.id"
							:value="option.id"
						>
							{{ option.code }} {{ option.name }}
						</option>
					</select>
				</li>
				<li
					v-if="sitesIn(center.id).length === 0"
					class="text-sm text-muted"
				>
					No sites bill to this cost center yet.
				</li>
			</ul>
		</section>
		<section
			v-if="unassigned.length > 0"
			class="rounded-md border border-dashed border-default p-4"
		>
			<h3 class="font-semibold text-default">Sites Without a Cost Center</h3>
			<ul class="mt-2 space-y-2">
				<li
					v-for="site in unassigned"
					:key="site.id"
					class="flex items-center justify-between gap-3"
				>
					<span class="text-default">{{ site.name }}</span>
					<select
						:class="selectClass"
						:disabled="saving || centers.length === 0"
						:aria-label="`Cost center for ${site.name}`"
						:value="''"
						@change="
							emit(
								'assign',
								site.id,
								($event.target as HTMLSelectElement).value || null
							)
						"
					>
						<option value="">Choose a Cost Center</option>
						<option
							v-for="option in centers"
							:key="option.id"
							:value="option.id"
						>
							{{ option.code }} {{ option.name }}
						</option>
					</select>
				</li>
			</ul>
		</section>
	</div>
</template>
