<script setup lang="ts">
import { MISSING_BADGE } from '~/shared/box-sites';
</script>

<template>
	<span class="inline-flex items-center gap-1.5 text-sm text-amber-800 dark:text-amber-300">
		<UIcon
			name="i-lucide-unplug"
			class="size-4 shrink-0"
			aria-hidden="true"
		/>
		<span>{{ MISSING_BADGE }}</span>
	</span>
</template>
