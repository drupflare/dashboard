<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useSitesStore } from '~/stores/sites';

const props = defineProps<{ orgId: string; siteId: string }>();

const sites = useSitesStore();

onMounted(() => void sites.load(props.orgId));

const release = computed(() => sites.byId.get(props.siteId)?.release);
const available = computed(() => release.value?.available ?? null);
const current = computed(() => release.value?.current ?? null);
const upToDate = computed(() => current.value !== null && current.value === available.value);

const confirming = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
// one key per confirm, so a second press while the first is pending asks for the same operation
let key = '';
let request: Promise<void> | null = null;

function open(): void {
	key = crypto.randomUUID();
	error.value = null;
	confirming.value = true;
}

function submit(): void {
	request ??= upgrade().finally(() => {
		request = null;
	});
}

async function upgrade(): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		const operation = await sites.upgrade(props.orgId, props.siteId, key);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<section
		v-if="available !== null"
		class="flex flex-wrap items-center gap-x-4 gap-y-2"
		aria-label="Release"
	>
		<template v-if="upToDate">
			<p class="inline-flex items-center gap-1.5 text-sm text-leaf-700 dark:text-leaf-300">
				<UIcon
					name="i-lucide-circle-check"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>Up to Date</span>
			</p>
			<p class="text-sm text-muted">Release {{ current }}</p>
		</template>

		<template v-else>
			<p class="inline-flex items-center gap-1.5 text-sm text-amber-800 dark:text-amber-300">
				<UIcon
					name="i-lucide-circle-arrow-up"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>Update Available</span>
			</p>
			<p class="text-sm text-muted">
				Running {{ current ?? 'an unrecorded release' }}. Latest is {{ available }}.
			</p>
			<UButton
				color="neutral"
				variant="outline"
				@click="open()"
				>Update</UButton
			>
		</template>

		<UModal
			v-model:open="confirming"
			title="Update Site"
			:description="`Move this site to release ${available}.`"
		>
			<template #body>
				<form
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<p class="text-sm text-default">
						The site keeps serving during the update, which takes several minutes. If
						the final check fails, the site returns to its old release on its own.
					</p>
					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>
					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="busy"
							:disabled="busy"
							>Update Site</UButton
						>
						<UButton
							type="button"
							color="neutral"
							variant="outline"
							@click="confirming = false"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</UModal>
	</section>
</template>
