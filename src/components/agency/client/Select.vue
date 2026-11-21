<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useClientsStore } from '~/stores/clients';

const props = defineProps<{
	orgId: string;
	siteId: string;
}>();

// the select refuses an empty value, so "no client" has a name of its own
const NONE = 'none';
const clients = useClientsStore();
const error = ref<string | null>(null);
const busy = ref(false);

const state = computed(() => clients.lists.get(props.orgId));
const items = computed(() => state.value?.items ?? []);
const loaded = computed(() => state.value?.status === 'ready');
const current = computed(
	() => items.value.find((client) => client.siteIds.includes(props.siteId))?.id ?? NONE
);
const choices = computed(() => [
	{ label: 'No Client', value: NONE },
	...items.value.map((client) => ({ label: client.name, value: client.id }))
]);

onMounted(() => {
	void clients.load(props.orgId);
});

// a site sits under one client, so the old grouping is taken off before the new one is added
async function choose(next: string): Promise<void> {
	if (next === current.value) return;
	error.value = null;
	busy.value = true;
	try {
		if (current.value !== NONE)
			await clients.removeSite(props.orgId, props.siteId, current.value);
		if (next !== NONE) await clients.addSite(props.orgId, props.siteId, next);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		await clients.reload(props.orgId);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<UFormField
		label="Client"
		hint="Groups this site under a client workspace."
		:error="error ?? undefined"
		class="max-w-md"
	>
		<USelect
			:model-value="current"
			:items="choices"
			:disabled="!loaded || busy"
			aria-label="Client"
			class="w-full"
			@update:model-value="choose($event)"
		/>
	</UFormField>
</template>
