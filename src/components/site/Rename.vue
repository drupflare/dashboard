<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { RENAME_LABEL } from '~/shared/box-sites';
import { useSitesStore, type SiteSummary } from '~/stores/sites';

const props = defineProps<{ orgId: string; siteId: string; name: string }>();
const emit = defineEmits<{ renamed: [site: SiteSummary] }>();

const sites = useSitesStore();
const editing = ref(false);
const draft = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const trimmed = computed(() => draft.value.trim());
const usable = computed(() => trimmed.value.length > 0 && trimmed.value.length <= 100);

function start(): void {
	draft.value = props.name;
	error.value = null;
	editing.value = true;
}

async function save(): Promise<void> {
	if (!usable.value || busy.value) return;
	busy.value = true;
	error.value = null;
	try {
		emit('renamed', await sites.rename(props.orgId, props.siteId, trimmed.value));
		editing.value = false;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="flex flex-col gap-2">
		<UButton
			v-if="!editing"
			color="neutral"
			variant="outline"
			icon="i-lucide-pencil"
			class="self-start"
			@click="start()"
			>{{ RENAME_LABEL }}</UButton
		>
		<form
			v-else
			class="flex flex-col gap-2"
			@submit.prevent="save()"
		>
			<label
				for="site-rename"
				class="text-sm font-medium text-highlighted"
				>Site Name</label
			>
			<UInput
				id="site-rename"
				v-model="draft"
				maxlength="100"
				autocomplete="off"
			/>
			<p
				v-if="error"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ error }}
			</p>
			<div class="flex gap-2">
				<UButton
					type="submit"
					color="primary"
					:loading="busy"
					:disabled="!usable"
					>Save Name</UButton
				>
				<UButton
					color="neutral"
					variant="outline"
					@click="editing = false"
					>Cancel</UButton
				>
			</div>
		</form>
	</div>
</template>
