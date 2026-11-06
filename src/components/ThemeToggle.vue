<script setup lang="ts">
const colorMode = useColorMode();

const options = [
	{ value: 'system', label: 'System', icon: 'i-lucide-monitor' },
	{ value: 'light', label: 'Light', icon: 'i-lucide-sun' },
	{ value: 'dark', label: 'Dark', icon: 'i-lucide-moon' }
] as const;

const current = computed(
	() => options.find((option) => option.value === colorMode.preference) ?? options[0]
);

function next() {
	const index = options.findIndex((option) => option.value === colorMode.preference);
	colorMode.preference = (options[(index + 1) % options.length] ?? options[0]).value;
}
</script>

<template>
	<UButton
		color="neutral"
		variant="ghost"
		:icon="current.icon"
		@click="next"
	>
		Theme: {{ current.label }}
	</UButton>
</template>
