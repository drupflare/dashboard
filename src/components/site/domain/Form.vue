<script setup lang="ts">
import { checkHostname } from '~/shared/domain-copy';

defineProps<{ busy: boolean; checking: boolean; error: string | null }>();
const emit = defineEmits<{ attach: [hostname: string]; check: [hostname: string] }>();

const hostname = ref('');
const touched = ref(false);

const checked = computed(() => checkHostname(hostname.value));
const problem = computed(() =>
	touched.value && hostname.value.trim() !== '' && !checked.value.ok
		? checked.value.message
		: null
);

function show(): void {
	touched.value = true;
	if (checked.value.ok) emit('check', checked.value.hostname);
}

function attach(): void {
	touched.value = true;
	if (checked.value.ok) emit('attach', checked.value.hostname);
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		@submit.prevent="show()"
	>
		<UFormField
			label="Domain"
			description="A domain you own, such as www.example.edu. Your site keeps its drupflare.app address."
			:error="problem ?? undefined"
		>
			<UInput
				v-model="hostname"
				name="hostname"
				class="w-full"
				autocomplete="off"
				@blur="touched = true"
			/>
		</UFormField>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<div class="flex flex-wrap gap-2">
			<UButton
				type="submit"
				color="neutral"
				variant="outline"
				:loading="checking"
				:disabled="checking || !checked.ok"
				>Show Records</UButton
			>
			<UButton
				type="button"
				:loading="busy"
				:disabled="busy || !checked.ok"
				@click="attach()"
				>Attach Domain</UButton
			>
		</div>
	</form>
</template>
