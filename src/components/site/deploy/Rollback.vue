<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useReleasesStore, type RollbackCheck } from '~/stores/releases';

const props = defineProps<{ orgId: string; siteId: string; release: string }>();

const releases = useReleasesStore();

const check = ref<RollbackCheck | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load(): Promise<void> {
	loading.value = true;
	loadError.value = null;
	try {
		check.value = await releases.rollbackCheck(props.orgId, props.siteId, props.release);
	} catch (cause) {
		check.value = null;
		loadError.value = toApiClientError(cause).message;
	} finally {
		loading.value = false;
	}
}

onMounted(load);
watch(() => [props.orgId, props.siteId, props.release], load);

const OFFERS = {
	'restore-data-with-code': 'Restore the data together with the code',
	'fix-forward': 'Fix the problem in a new release'
} as const;

const confirming = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
let key = '';
let request: Promise<void> | null = null;

function ask(): void {
	key = crypto.randomUUID();
	error.value = null;
	confirming.value = true;
}

function submit(): void {
	request ??= rollBack().finally(() => {
		request = null;
	});
}

async function rollBack(): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		const operation = await releases.rollback(props.orgId, props.siteId, props.release, key);
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
		class="flex max-w-prose flex-col gap-3"
		aria-label="Roll back the code"
	>
		<p
			v-if="loading"
			role="status"
			class="text-sm text-muted"
		>
			Checking whether the earlier code can run on this site's data
		</p>
		<div
			v-else-if="loadError"
			role="alert"
			class="flex flex-wrap items-center gap-3 text-sm text-red-700 dark:text-red-400"
		>
			<span>{{ loadError }}</span>
			<UButton
				color="neutral"
				variant="outline"
				size="sm"
				@click="load()"
				>Try Again</UButton
			>
		</div>
		<template v-else-if="check">
			<template v-if="check.allowed">
				<p
					class="inline-flex items-center gap-1.5 text-sm text-leaf-700 dark:text-leaf-300"
				>
					<UIcon
						name="i-lucide-circle-check"
						class="size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>The earlier code can run on this site's data.</span>
				</p>
				<p class="text-sm text-muted">
					Only the code goes back. Your content and settings stay as they are now.
				</p>
				<div v-if="!confirming">
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-undo-2"
						@click="ask()"
						>Roll Back the Code</UButton
					>
				</div>
				<div
					v-else
					class="flex flex-wrap items-center gap-3"
				>
					<UButton
						color="error"
						:loading="busy"
						:disabled="busy"
						@click="submit()"
						>Confirm Roll Back</UButton
					>
					<UButton
						color="neutral"
						variant="outline"
						:disabled="busy"
						@click="confirming = false"
						>Cancel</UButton
					>
				</div>
				<p
					v-if="error"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ error }}
				</p>
			</template>
			<template v-else>
				<p class="inline-flex items-center gap-1.5 text-sm text-red-700 dark:text-red-400">
					<UIcon
						name="i-lucide-octagon-x"
						class="size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>The code cannot go back on its own.</span>
				</p>
				<p class="text-sm text-default">{{ check.reason }}</p>
				<ul
					v-if="check.offers.length > 0"
					class="flex list-disc flex-col gap-1 pl-5 text-sm text-default"
					aria-label="What you can do instead"
				>
					<li
						v-for="offer in check.offers"
						:key="offer"
					>
						{{ OFFERS[offer] }}
					</li>
				</ul>
			</template>
		</template>
	</section>
</template>
