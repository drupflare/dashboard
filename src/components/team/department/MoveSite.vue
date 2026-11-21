<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { PlacementSite } from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';

const props = defineProps<{
	orgId: string;
	departmentId: string;
	sites: PlacementSite[];
	central: boolean;
}>();

const store = useDepartmentsStore();

const chosen = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

// a site already here has nowhere to move to; a site elsewhere moves only for people who can place it
const movable = computed(() =>
	props.sites
		.filter((site) => site.departmentId !== props.departmentId)
		.map((site) => ({ label: site.name, value: site.id }))
);
const here = computed(() => props.sites.filter((site) => site.departmentId === props.departmentId));

async function move(siteId: string, to: string | null): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		await store.moveSite(props.orgId, siteId, to);
		chosen.value = '';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="flex flex-col gap-4">
		<UiEmptyState
			v-if="here.length === 0"
			icon="i-lucide-globe"
			title="No Sites Here"
			text="Move a site into this department, or create one from the site list."
		/>
		<ul
			v-else
			class="divide-y divide-default rounded-lg border border-default px-4"
		>
			<li
				v-for="site in here"
				:key="site.id"
				class="flex items-center justify-between gap-3 py-2"
			>
				<NuxtLink
					:to="`/sites/${encodeURIComponent(site.id)}`"
					class="font-medium wrap-break-word text-highlighted underline-offset-2 hover:underline"
					>{{ site.name }}</NuxtLink
				>
				<UButton
					v-if="central"
					color="neutral"
					variant="outline"
					size="sm"
					:aria-label="`Take ${site.name} out of this department`"
					:disabled="busy"
					@click="move(site.id, null)"
					>Take Out</UButton
				>
			</li>
		</ul>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<form
			v-if="movable.length > 0"
			class="flex flex-col gap-3 sm:flex-row sm:items-end"
			@submit.prevent="chosen !== '' && move(chosen, departmentId)"
		>
			<UFormField
				label="Move a Site Here"
				class="flex-1"
			>
				<USelect
					v-model="chosen"
					:items="movable"
					placeholder="Choose a site"
					aria-label="Move a Site Here"
					class="w-full"
				/>
			</UFormField>
			<UButton
				type="submit"
				:loading="busy"
				:disabled="chosen === ''"
				>Move Site</UButton
			>
		</form>
	</div>
</template>
