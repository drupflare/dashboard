<script setup lang="ts">
defineProps<{
	label: string;
	available: boolean;
	canConnect: boolean;
	busy: boolean;
	text?: string;
}>();

const emit = defineEmits<{ connect: [] }>();
</script>

<template>
	<li class="flex flex-col gap-3 rounded-lg border border-default p-4">
		<h3 class="font-medium text-highlighted">{{ label }}</h3>
		<p
			v-if="text"
			class="text-sm text-muted"
		>
			{{ text }}
		</p>
		<div v-if="available">
			<UButton
				:disabled="!canConnect || busy"
				:loading="busy"
				@click="emit('connect')"
			>
				Connect {{ label }}
			</UButton>
			<p
				v-if="!canConnect"
				class="mt-2 text-sm text-muted"
			>
				Only organization owners and admins can connect a provider.
			</p>
		</div>
		<UButton
			v-else
			disabled
			color="neutral"
			variant="outline"
			class="self-start"
		>
			Coming Soon
		</UButton>
	</li>
</template>
