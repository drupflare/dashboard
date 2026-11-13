<script setup lang="ts">
import { SITE_KIND_LABELS, SITE_PLANE_LABELS, type SiteSummary } from '~/stores/sites';

defineProps<{ site: SiteSummary }>();
</script>

<template>
	<header class="flex flex-col gap-2">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<h1 class="wrap-break-word text-2xl font-semibold text-highlighted">{{ site.name }}</h1>
			<SiteStatus :state="site.state" />
		</div>
		<p class="text-sm text-muted">
			{{ SITE_KIND_LABELS[site.kind] }} on {{ SITE_PLANE_LABELS[site.plane] }}
		</p>
		<p
			v-if="site.primaryHostname"
			class="wrap-break-word text-sm"
		>
			<a
				:href="`https://${site.primaryHostname}`"
				class="font-medium text-brand-700 underline dark:text-brand-300"
				>{{ site.primaryHostname }}</a
			>
		</p>
		<p
			v-else
			class="text-sm text-muted"
		>
			Not Set
		</p>
		<div class="flex flex-wrap gap-x-4 gap-y-1">
			<SiteFound v-if="site.box?.found" />
			<SiteMissing v-if="site.box?.missingSince" />
		</div>
	</header>
</template>
