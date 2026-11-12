<script setup lang="ts">
import { dollars, type UsageView } from '~/shared/capacity';

const props = defineProps<{ view: UsageView }>();

const SHOWN = 8;

const rows = computed(() => (props.view.state === 'ok' ? props.view.services.slice(0, SHOWN) : []));
const hidden = computed(() =>
	props.view.state === 'ok' ? Math.max(0, props.view.services.length - SHOWN) : 0
);
const widest = computed(() => Math.max(1, ...rows.value.map((row) => row.cents)));
</script>

<template>
	<section
		class="flex max-w-xl flex-col gap-3"
		aria-labelledby="capacity-usage"
	>
		<h2
			id="capacity-usage"
			class="text-lg font-semibold text-highlighted"
		>
			Usage by Service
		</h2>
		<p
			v-if="view.state !== 'ok'"
			class="text-muted"
			role="status"
		>
			{{
				view.state === 'not_configured'
					? 'The dashboard has no Cloudflare credentials yet, so it cannot read usage.'
					: 'Usage Detail Is Unavailable'
			}}
		</p>
		<p
			v-else-if="view.services.length === 0"
			class="text-muted"
		>
			No usage is recorded for this billing period yet.
		</p>
		<template v-else>
			<p class="text-sm text-muted">
				{{ view.from }} to {{ view.through }}, effective cost. Total
				{{ dollars(view.totalCents, view.currency) }}.
			</p>
			<table class="w-full text-left text-sm">
				<thead class="text-muted">
					<tr>
						<th
							scope="col"
							class="py-2 font-medium"
						>
							Service
						</th>
						<th
							scope="col"
							class="py-2 font-medium"
						>
							Share
						</th>
						<th
							scope="col"
							class="py-2 text-right font-medium"
						>
							Effective Cost
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in rows"
						:key="row.name"
						class="border-t border-default"
					>
						<td class="py-2 text-highlighted">{{ row.name }}</td>
						<td class="w-1/3 py-2">
							<div
								aria-hidden="true"
								class="h-2 w-full overflow-hidden rounded-full bg-elevated"
							>
								<div
									class="h-2 bg-primary"
									:style="{
										width: `${Math.max(0, (row.cents * 100) / widest)}%`
									}"
								/>
							</div>
						</td>
						<td class="py-2 text-right font-medium text-highlighted">
							{{ dollars(row.cents, view.currency) }}
						</td>
					</tr>
				</tbody>
			</table>
			<p
				v-if="hidden > 0"
				class="text-sm text-muted"
			>
				and {{ hidden }} more {{ hidden === 1 ? 'service' : 'services' }} below these.
			</p>
		</template>
	</section>
</template>
