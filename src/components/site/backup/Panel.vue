<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useBackupsStore, type BackupFile, type BackupView } from '~/stores/backups';

const props = defineProps<{ orgId: string; siteId: string }>();

const backups = useBackupsStore();
const list = computed(() => backups.listFor(props.orgId, props.siteId));
const items = computed(() => list.value?.items ?? []);

function load(): void {
	void backups.load(props.orgId, props.siteId);
}

onMounted(load);
watch(() => [props.orgId, props.siteId], load);

const starting = ref(false);
const startError = ref<string | null>(null);
const notice = ref('');
let startRequest: Promise<void> | null = null;

// one request in flight: a double click reuses the pending start and its key
function backUpNow(): void {
	startRequest ??= startBackup().finally(() => {
		startRequest = null;
	});
}

async function startBackup(): Promise<void> {
	startError.value = null;
	notice.value = '';
	starting.value = true;
	try {
		const operation = await backups.startBackup(props.orgId, props.siteId, crypto.randomUUID());
		notice.value = 'Backup Started';
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		startError.value = toApiClientError(cause).message;
	} finally {
		starting.value = false;
	}
}

const restoring = ref<BackupView | null>(null);
const downloading = ref<string | null>(null);
const downloadError = ref<{ message: string; signIn: boolean } | null>(null);

async function download(backup: BackupView): Promise<void> {
	downloadError.value = null;
	downloading.value = backup.id;
	try {
		saveFile(await backups.download(props.orgId, props.siteId, backup.id));
	} catch (cause) {
		const error = toApiClientError(cause);
		const signIn = error.status === 403;
		downloadError.value = {
			message: signIn
				? 'Downloading needs a fresh sign-in. Confirm it on the Account page, then try again.'
				: error.message,
			signIn
		};
	} finally {
		downloading.value = null;
	}
}

function saveFile({ blob, filename }: BackupFile): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const loadMoreError = computed(() =>
	list.value?.status === 'error' && items.value.length > 0 ? list.value.error?.message : null
);
</script>

<template>
	<section
		class="flex max-w-3xl flex-col gap-4"
		aria-labelledby="backups-heading"
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2
				id="backups-heading"
				class="text-lg font-semibold text-highlighted"
			>
				Backups
			</h2>
			<UButton
				icon="i-lucide-archive"
				:loading="starting"
				:disabled="starting"
				@click="backUpNow()"
				>Back Up Now</UButton
			>
		</div>

		<p
			role="status"
			aria-live="polite"
			class="text-sm text-muted"
		>
			{{ notice }}
		</p>
		<p
			v-if="startError"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ startError }}
		</p>

		<p
			v-if="downloadError"
			role="alert"
			class="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-400"
		>
			<span>{{ downloadError.message }}</span>
			<UButton
				v-if="downloadError.signIn"
				to="/account"
				variant="link"
				>Go to Account</UButton
			>
		</p>

		<UiSkeletonTable
			v-if="!list || (list.status === 'loading' && items.length === 0)"
			label="Loading backups"
			:rows="3"
		/>

		<UiErrorState
			v-else-if="list.status === 'error' && items.length === 0"
			title="Could Not Load Backups"
			:text="list.error?.message"
			:request-id="list.error?.requestId"
		>
			<UButton
				color="neutral"
				@click="backups.reload(orgId, siteId)"
				>Try Again</UButton
			>
		</UiErrorState>

		<UiEmptyState
			v-else-if="items.length === 0"
			icon="i-lucide-archive"
			title="No Backups Yet"
			text="The first backup appears here once you back up this site."
		/>

		<template v-else>
			<p class="text-sm text-muted">
				Download saves the site's database as one SQL file. The file holds no secrets.
			</p>

			<SiteBackupTable
				:backups="items"
				:downloading="downloading"
				@restore="restoring = $event"
				@download="download"
			/>

			<div
				v-if="loadMoreError"
				class="flex flex-wrap items-center gap-3"
			>
				<p
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ loadMoreError }}
				</p>
				<UButton
					color="neutral"
					variant="outline"
					@click="backups.loadMore(orgId, siteId)"
					>Try Again</UButton
				>
			</div>
			<UButton
				v-else-if="list.nextCursor"
				color="neutral"
				variant="outline"
				class="self-start"
				:loading="list.status === 'loading'"
				@click="backups.loadMore(orgId, siteId)"
				>Load More</UButton
			>
		</template>

		<SiteBackupRestore
			v-if="restoring"
			:org-id="orgId"
			:site-id="siteId"
			:backup="restoring"
			@close="restoring = null"
		/>
	</section>
</template>
