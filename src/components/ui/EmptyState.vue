<script setup lang="ts">
defineProps<{
	icon: string;
	title: string;
	text?: string;
}>();
</script>

<template>
	<div
		class="flex flex-col items-center gap-3 rounded-lg border border-dashed border-default px-6 py-10 text-center"
	>
		<UIcon
			:name="icon"
			class="size-8 text-muted"
			aria-hidden="true"
		/>
		<h2 class="text-lg font-semibold text-highlighted">{{ title }}</h2>
		<p
			v-if="text"
			class="max-w-prose text-sm text-muted"
		>
			{{ text }}
		</p>
		<slot />
	</div>
</template>
