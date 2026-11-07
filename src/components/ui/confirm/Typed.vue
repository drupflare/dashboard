<script setup lang="ts">
const props = withDefaults(
	defineProps<{
		expected: string;
		label: string;
		action?: string;
		busy?: boolean;
	}>(),
	{ action: 'Confirm', busy: false }
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const id = useId();
const typed = ref('');
const touched = ref(false);

const matches = computed(() => typed.value === props.expected);
// punish late: a name still being typed is not an error until the person leaves the field
const mismatch = computed(() =>
	touched.value && typed.value !== '' && !matches.value
		? 'This does not match. Type the name exactly as shown, including capitals.'
		: null
);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// the dialog opens from this element, which still has focus while the form is set up
const trigger = import.meta.client ? document.activeElement : null;

function submit(): void {
	touched.value = true;
	if (!matches.value || props.busy) return;
	emit('confirm');
}

function cancel(): void {
	emit('cancel');
	void nextTick(() => {
		if (trigger instanceof HTMLElement) trigger.focus();
	});
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		@submit.prevent="submit()"
	>
		<UiField
			:id="`${id}-typed`"
			:label="label"
			:hint="`Type ${expected} to continue.`"
			:error="mismatch"
			v-slot="{ describedBy }"
		>
			<input
				:id="`${id}-typed`"
				v-model="typed"
				type="text"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				:class="inputClass"
				:aria-invalid="mismatch ? 'true' : undefined"
				:aria-describedby="describedBy"
				@blur="touched = true"
			/>
		</UiField>
		<div class="flex gap-3">
			<UButton
				type="submit"
				color="error"
				:loading="busy"
				:disabled="!matches || busy"
				>{{ action }}</UButton
			>
			<UButton
				type="button"
				color="neutral"
				variant="outline"
				@click="cancel()"
				>Cancel</UButton
			>
		</div>
	</form>
</template>
