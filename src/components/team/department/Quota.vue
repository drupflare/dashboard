<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { MAX_SITE_QUOTA } from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';

const props = defineProps<{ orgId: string; departmentId: string; siteQuota: number | null }>();

const store = useDepartmentsStore();
const id = useId();
const text = ref(props.siteQuota === null ? '' : String(props.siteQuota));
const busy = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

watch(
	() => props.siteQuota,
	(next) => {
		text.value = next === null ? '' : String(next);
	}
);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

async function submit(): Promise<void> {
	error.value = null;
	saved.value = false;
	const raw = text.value.trim();
	let next: number | null = null;
	if (raw !== '') {
		if (!/^\d+$/.test(raw) || Number(raw) > MAX_SITE_QUOTA) {
			error.value = `Enter a whole number from 0 to ${MAX_SITE_QUOTA}, or leave it empty for no limit.`;
			return;
		}
		next = Number(raw);
	}
	busy.value = true;
	try {
		await store.setQuota(props.orgId, props.departmentId, next);
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
			:id="`quota-${id}`"
			label="Site Limit"
			hint="Counts every site in this department and the departments inside it. Leave it empty for no limit. A limit below the current count stops new sites and removes none."
			v-slot="{ describedBy }"
		>
			<input
				:id="`quota-${id}`"
				v-model="text"
				type="text"
				inputmode="numeric"
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
			Site Limit saved.
		</p>
		<div>
			<UButton
				type="submit"
				:loading="busy"
				>Save Site Limit</UButton
			>
		</div>
	</form>
</template>
