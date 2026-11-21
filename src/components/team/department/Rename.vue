<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useDepartmentsStore } from '~/stores/departments';

const props = defineProps<{ orgId: string; departmentId: string; name: string }>();

const store = useDepartmentsStore();
const id = useId();
const value = ref(props.name);
const busy = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

watch(
	() => props.name,
	(next) => {
		value.value = next;
	}
);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

async function submit(): Promise<void> {
	error.value = null;
	saved.value = false;
	const label = value.value.trim();
	if (label === '') {
		error.value = 'Enter a name for the department.';
		return;
	}
	if (label === props.name) return;
	busy.value = true;
	try {
		await store.edit(props.orgId, props.departmentId, { name: label });
		saved.value = true;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form
		class="flex flex-col gap-3"
		@submit.prevent="submit()"
	>
		<UiField
			:id="`rename-${id}`"
			label="Name"
			v-slot="{ describedBy }"
		>
			<input
				:id="`rename-${id}`"
				v-model="value"
				type="text"
				maxlength="80"
				:class="inputClass"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<p
			v-else-if="saved"
			role="status"
			class="text-sm text-muted"
		>
			Name saved.
		</p>
		<div>
			<UButton
				type="submit"
				:loading="busy"
				>Rename</UButton
			>
		</div>
	</form>
</template>
