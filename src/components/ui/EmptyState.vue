<script setup lang="ts">
defineProps<{
	icon: string;
	title: string;
	text?: string;
}>();
</script>

<template>
	<div class="flex flex-col items-start gap-1 border-t border-default py-6">
		<h2 class="flex items-center gap-2 font-medium text-highlighted">
			<UIcon
				:name="icon"
				class="size-4 shrink-0 text-muted"
				aria-hidden="true"
			/>
			{{ title }}
		</h2>
		<p
			v-if="text"
			class="max-w-prose text-sm text-muted"
		>
			{{ text }}
		</p>
		<div
			v-if="$slots.default"
			class="mt-2 flex flex-wrap gap-2"
		>
			<slot />
		</div>
	</div>
</template>
