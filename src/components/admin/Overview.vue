<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError } from '~/composables/useApi';

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
		data.value = await adminGet<Overview>('/admin/overview');
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
	<div
		v-else-if="!data"
		role="status"
	>
		<span class="sr-only">Loading the totals</span>
		<div
			aria-hidden="true"
			class="flex max-w-md flex-col gap-8"
		>
			<div class="flex flex-col gap-3">
				<USkeleton
					v-for="line in 2"
					:key="line"
					class="h-6 w-full"
				/>
			</div>
			<div
				v-for="group in 2"
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
