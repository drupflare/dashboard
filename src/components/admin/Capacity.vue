<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError } from '~/composables/useApi';
import { usePoll } from '~/composables/usePoll';
import { CAPACITY_REFRESH_MS, capacityWarnings, type CapacityView } from '~/shared/capacity';

const data = ref<CapacityView | null>(null);
const error = ref('');

async function load() {
	try {
		data.value = await adminGet<CapacityView>('/admin/capacity');
		error.value = '';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}

const poll = usePoll(load, { minMs: CAPACITY_REFRESH_MS, maxMs: CAPACITY_REFRESH_MS });
onMounted(poll.start);

const warnings = computed(() => (data.value ? capacityWarnings(data.value) : []));
const updated = computed(() =>
	data.value ? new Date(data.value.generatedAt).toISOString().slice(11, 19) : ''
);
</script>

<template>
	<UiErrorState
		v-if="error && !data"
		title="Could Not Load Capacity"
		:text="error"
	>
		<UButton
			color="neutral"
			@click="poll.refresh()"
			>Try Again</UButton
		>
	</UiErrorState>
	<div
		v-else-if="!data"
		role="status"
	>
		<span class="sr-only">Loading capacity</span>
		<div
			aria-hidden="true"
			class="flex max-w-md flex-col gap-8"
		>
			<div
				v-for="group in 3"
				:key="group"
				class="flex flex-col gap-3"
			>
				<USkeleton class="h-6 w-40" />
				<USkeleton class="h-5 w-full" />
				<USkeleton class="h-5 w-full" />
			</div>
		</div>
	</div>
	<div
		v-else
		class="flex flex-col gap-8"
	>
		<p class="text-sm text-muted">
			Updated {{ updated }} UTC. This page refreshes every minute.
			<span
				v-if="error"
				role="status"
				>The last refresh failed, so these numbers may be out of date.</span
			>
		</p>
		<AdminCapacityWarnings :warnings="warnings" />
		<AdminCapacityCredits :view="data.credits" />
		<AdminCapacityUsage :view="data.usage" />
		<AdminCapacityHeadroom :view="data.headroom" />
		<AdminCapacityWork :view="data.work" />
	</div>
</template>
