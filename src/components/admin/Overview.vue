<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';

interface Overview {
	users: number;
	organizations: number;
	sites: Record<string, number>;
	operations: Record<string, number>;
}

const data = ref<Overview | null>(null);
const error = ref('');

async function load() {
	error.value = '';
	try {
		data.value = await useApi().get<Overview>('/admin/overview');
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	}
}

onMounted(load);

const groups = computed(() =>
	data.value
		? [
				{ label: 'Sites by State', rows: Object.entries(data.value.sites) },
				{ label: 'Operations by Status', rows: Object.entries(data.value.operations) }
			]
		: []
);
</script>

<template>
	<UiErrorState
		v-if="error"
		title="Could Not Load the Totals"
		:text="error"
	>
		<UButton
			color="neutral"
			@click="load"
			>Try Again</UButton
		>
	</UiErrorState>
	<p
		v-else-if="!data"
		role="status"
		class="text-sm text-muted"
	>
		Loading...
	</p>
	<div
		v-else
		class="flex flex-col gap-8"
	>
		<dl class="grid max-w-md grid-cols-2 gap-y-3 text-lg">
			<dt class="text-muted">Users</dt>
			<dd class="text-right font-semibold text-highlighted">{{ data.users }}</dd>
			<dt class="text-muted">Organizations</dt>
			<dd class="text-right font-semibold text-highlighted">{{ data.organizations }}</dd>
		</dl>
		<section
			v-for="group in groups"
			:key="group.label"
			class="flex max-w-md flex-col gap-2"
		>
			<h2 class="text-lg font-semibold text-highlighted">{{ group.label }}</h2>
			<p
				v-if="group.rows.length === 0"
				class="text-muted"
			>
				None yet.
			</p>
			<dl
				v-else
				class="grid grid-cols-2 gap-y-2"
			>
				<template
					v-for="[name, count] in group.rows"
					:key="name"
				>
					<dt class="text-muted">{{ name }}</dt>
					<dd class="text-right font-medium text-highlighted">{{ count }}</dd>
				</template>
			</dl>
		</section>
	</div>
</template>
