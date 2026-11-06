<script setup lang="ts">
const props = defineProps<{
	id: string;
	label: string;
	hint?: string;
	error?: string | null;
}>();

const hintId = computed(() => `${props.id}-hint`);
const errorId = computed(() => `${props.id}-error`);
const describedBy = computed(() => {
	const ids = [props.hint ? hintId.value : null, props.error ? errorId.value : null];
	return ids.filter(Boolean).join(' ') || undefined;
});
</script>

<template>
	<div class="flex flex-col gap-1.5">
		<label
			:for="id"
			class="text-sm font-medium text-default"
			>{{ label }}</label
		>
		<slot :describedBy="describedBy" />
		<p
			v-if="hint"
			:id="hintId"
			class="text-sm text-muted"
		>
			{{ hint }}
		</p>
		<p
			v-if="error"
			:id="errorId"
			role="alert"
			class="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400"
		>
			<UIcon
				name="i-lucide-circle-alert"
				class="mt-0.5 size-4 shrink-0"
				aria-hidden="true"
			/>
			<span>{{ error }}</span>
		</p>
	</div>
</template>
