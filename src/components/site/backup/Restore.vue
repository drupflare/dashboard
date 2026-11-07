<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useBackupsStore, type BackupView } from '~/stores/backups';
import { useSitesStore } from '~/stores/sites';

const props = defineProps<{ orgId: string; siteId: string; backup: BackupView }>();
const emit = defineEmits<{ close: [] }>();

const backups = useBackupsStore();
const sites = useSitesStore();

const targets = computed(() =>
	sites.forOrg(props.orgId).filter((site) => site.id !== props.siteId)
);
const targetList = computed(() => sites.lists.get(props.orgId));

// the target list must be complete before the person can choose from it
async function loadTargets(): Promise<void> {
	await sites.load(props.orgId);
	let list = sites.lists.get(props.orgId);
	while (list?.status === 'ready' && list.nextCursor) {
		await sites.loadMore(props.orgId);
		list = sites.lists.get(props.orgId);
	}
}

onMounted(() => void loadTargets());

const targetSiteId = ref('');
const understood = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
let request: Promise<void> | null = null;

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// one request in flight: a second submit while the first is pending reuses it
function submit(): void {
	if (!targetSiteId.value || !understood.value) return;
	request ??= restore().finally(() => {
		request = null;
	});
}

async function restore(): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		const operation = await backups.restore(
			props.orgId,
			props.siteId,
			props.backup.id,
			targetSiteId.value,
			crypto.randomUUID()
		);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}

function onOpenChange(value: boolean): void {
	if (!value) emit('close');
}
</script>

<template>
	<UModal
		:open="true"
		title="Restore Backup"
		:description="`Copy the backup from ${dateFormat.format(new Date(backup.createdAt))} into another site.`"
		@update:open="onOpenChange"
	>
		<template #body>
			<form
				class="flex flex-col gap-4"
				@submit.prevent="submit()"
			>
				<p class="text-sm text-default">
					The target site's content is replaced by this backup. This cannot be undone.
				</p>

				<div
					v-if="targetList?.status === 'loading' && targets.length === 0"
					role="status"
					class="flex flex-col gap-2"
				>
					<span class="sr-only">Loading sites</span>
					<USkeleton
						class="h-5 w-24"
						aria-hidden="true"
					/>
					<USkeleton
						class="h-10 w-full"
						aria-hidden="true"
					/>
				</div>

				<div
					v-else-if="targetList?.status === 'error' && targets.length === 0"
					class="flex flex-col gap-2"
				>
					<p
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ targetList.error?.message }}
					</p>
					<UButton
						color="neutral"
						variant="outline"
						class="self-start"
						@click="loadTargets()"
					>
						Try Again
					</UButton>
				</div>

				<div
					v-else-if="targets.length === 0"
					class="flex flex-col items-start gap-3"
				>
					<p class="text-sm text-muted">
						This organization has no other site to restore into.
					</p>
					<UButton
						to="/new"
						icon="i-lucide-plus"
						>Create a Site</UButton
					>
				</div>

				<template v-else>
					<UiField
						id="restore-target"
						label="Target Site"
						:error="error"
						v-slot="{ describedBy }"
					>
						<select
							id="restore-target"
							v-model="targetSiteId"
							required
							:class="inputClass"
							:aria-describedby="describedBy"
						>
							<option
								value=""
								disabled
							>
								Choose a Site
							</option>
							<option
								v-for="site in targets"
								:key="site.id"
								:value="site.id"
							>
								{{ site.name }}
							</option>
						</select>
					</UiField>

					<label class="flex items-start gap-3 text-sm text-default">
						<input
							v-model="understood"
							type="checkbox"
							class="mt-0.5 size-4 accent-primary"
						/>
						<span>I understand the target site's content will be replaced.</span>
					</label>
				</template>

				<div class="flex gap-3">
					<UButton
						type="submit"
						:loading="busy"
						:disabled="!targetSiteId || !understood || busy"
						>Restore Backup</UButton
					>
					<UButton
						type="button"
						color="neutral"
						variant="outline"
						@click="emit('close')"
						>Cancel</UButton
					>
				</div>
			</form>
		</template>
	</UModal>
</template>
