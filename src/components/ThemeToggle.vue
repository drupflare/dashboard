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
	<ClientOnly>
		<UButton
			color="neutral"
			variant="ghost"
			:icon="current.icon"
			:aria-label="`Theme: ${current.label}. Switch theme`"
			:title="`Theme: ${current.label}`"
			@click="next"
		/>
		<template #fallback>
			<UButton
				color="neutral"
				variant="ghost"
				icon="i-lucide-monitor"
				aria-label="Theme"
				disabled
			/>
		</template>
	</ClientOnly>
</template>
