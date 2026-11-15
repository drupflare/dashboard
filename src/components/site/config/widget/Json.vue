<script setup lang="ts">
const props = defineProps<{ value: unknown }>();

const text = computed(() =>
	props.value === undefined || props.value === null
		? 'Not Set'
		: JSON.stringify(props.value, null, 2)
);
</script>

<template>
	<pre class="max-h-64 overflow-auto rounded-md bg-elevated p-3 font-mono text-xs">{{
		text
	}}</pre>
</template>
