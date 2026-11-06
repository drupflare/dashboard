<script setup lang="ts">
import { SITE_KIND_LABELS, SITE_PLANE_LABELS, type SiteSummary } from '~/stores/sites';

defineProps<{ sites: SiteSummary[] }>();
</script>

<template>
	<div class="hidden overflow-x-auto rounded-lg border border-default md:block">
		<table class="w-full text-left text-sm">
			<thead class="bg-elevated text-muted">
				<tr>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Name
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Kind
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Plane
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Status
					</th>
					<th
						scope="col"
						class="px-4 py-3 font-medium"
					>
						Primary Hostname
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="site in sites"
					:key="site.id"
					class="border-t border-default"
				>
					<td class="px-4 py-3 font-medium text-highlighted">{{ site.name }}</td>
					<td class="px-4 py-3">{{ SITE_KIND_LABELS[site.kind] }}</td>
					<td class="px-4 py-3">{{ SITE_PLANE_LABELS[site.plane] }}</td>
					<td class="px-4 py-3">
						<SiteStatus :state="site.state" />
					</td>
					<td class="wrap-break-word px-4 py-3 text-muted">
						{{ site.primaryHostname ?? 'Not Set' }}
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
