<script setup lang="ts">
import { SITE_KIND_LABELS, SITE_PLANE_LABELS, type SiteSummary } from '~/stores/sites';

defineProps<{ site: SiteSummary }>();
</script>

<template>
	<li class="flex flex-col gap-2 rounded-lg border border-default p-4">
		<div class="flex items-start justify-between gap-3">
			<h3 class="wrap-break-word font-medium text-highlighted">{{ site.name }}</h3>
			<SiteStatus :state="site.state" />
		</div>
		<p class="text-sm text-muted">
			{{ SITE_KIND_LABELS[site.kind] }} on {{ SITE_PLANE_LABELS[site.plane] }}
		</p>
		<p class="wrap-break-word text-sm text-muted">{{ site.primaryHostname ?? 'Not Set' }}</p>
	</li>
</template>
