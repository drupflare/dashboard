<script setup lang="ts">
const props = defineProps<{ value: unknown }>();

const text = computed(() => (typeof props.value === 'string' ? props.value : ''));
</script>

<template>
	<div class="flex items-center gap-2">
		<span
			v-if="text"
			class="size-5 rounded border border-default"
			:style="{ backgroundColor: text }"
			aria-hidden="true"
		/>
		<span class="font-mono text-sm">{{ text || 'Not Set' }}</span>
	</div>
</template>
