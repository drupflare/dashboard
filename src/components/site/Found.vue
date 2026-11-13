<script setup lang="ts">
import { FOUND_BADGE } from '~/shared/box-sites';
</script>

<template>
	<span class="inline-flex items-center gap-1.5 text-sm text-brand-700 dark:text-brand-300">
		<UIcon
			name="i-lucide-radar"
			class="size-4 shrink-0"
			aria-hidden="true"
		/>
		<span>{{ FOUND_BADGE }}</span>
	</span>
</template>
