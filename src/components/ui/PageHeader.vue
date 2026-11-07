<script setup lang="ts">
defineProps<{ title: string; text?: string | null }>();
</script>

<template>
	<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
		<div class="flex min-w-0 flex-col gap-1">
			<h1 class="text-2xl font-bold text-highlighted sm:text-3xl">{{ title }}</h1>
			<p
				v-if="text"
				class="text-muted"
			>
				{{ text }}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<slot />
		</div>
	</div>
</template>
