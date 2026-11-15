<script setup lang="ts">
import type { SiteKind } from '@contracts/sites';

const props = defineProps<{ siteId: string; kind: SiteKind }>();

const base = computed(() => `/sites/${encodeURIComponent(props.siteId)}`);
const sections = computed(() => [
	...(props.kind === 'drupal'
		? [
				{ path: '/config', label: 'Settings', icon: 'i-lucide-settings' },
				{ path: '/modules', label: 'Modules', icon: 'i-lucide-plug' }
			]
		: []),
	{ path: '/access', label: 'Access', icon: 'i-lucide-shield-check' },
	{ path: '/environments', label: 'Environments', icon: 'i-lucide-layers' },
	{ path: '/repairs', label: 'Repairs', icon: 'i-lucide-wrench' },
	{ path: '/restore-points', label: 'Restore Points', icon: 'i-lucide-history' }
]);
</script>

<template>
	<nav
		aria-label="Site Sections"
		class="flex flex-wrap gap-2"
	>
		<UButton
			v-for="section in sections"
			:key="section.path"
			color="neutral"
			variant="outline"
			:icon="section.icon"
			:to="`${base}${section.path}`"
		>
			{{ section.label }}
		</UButton>
	</nav>
</template>
