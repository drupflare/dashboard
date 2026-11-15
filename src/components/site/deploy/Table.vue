<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useReleasesStore, type RevisionItem } from '~/stores/releases';

const props = defineProps<{ orgId: string; siteId: string; items: RevisionItem[] }>();

const releases = useReleasesStore();

const rollingBack = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
let key = '';
let request: Promise<void> | null = null;

const when = (at: number) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

const label = (item: RevisionItem) =>
	item.kind === 'edit' ? 'Edit' : `Release ${item.version ?? item.release ?? ''}`.trim();

const canRollBack = (item: RevisionItem) =>
	item.kind === 'release' ? item.release !== null : item.bundle;

function toggle(item: RevisionItem): void {
	rollingBack.value = rollingBack.value === item.id ? null : item.id;
	key = crypto.randomUUID();
	error.value = null;
}

function submit(revision: string): void {
	request ??= rollBackEdit(revision).finally(() => {
		request = null;
	});
}

async function rollBackEdit(revision: string): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		const operation = await releases.rollbackEdit(props.orgId, props.siteId, revision, key);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<ul class="rounded-lg border border-default">
		<li
			v-for="item in items"
			:key="item.id"
			class="flex flex-col gap-3 border-b border-default p-3 last:border-b-0"
		>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-col gap-0.5">
					<span class="text-sm font-medium text-highlighted">{{ label(item) }}</span>
					<span class="text-sm text-muted">{{ when(item.createdAt) }}</span>
					<span
						v-if="item.note"
						class="text-sm text-default"
						>{{ item.note }}</span
					>
				</div>
				<span
					v-if="item.current"
					class="inline-flex items-center gap-1.5 text-sm text-leaf-700 dark:text-leaf-300"
				>
					<UIcon
						name="i-lucide-circle-check"
						class="size-4"
						aria-hidden="true"
					/>
					Running Now
				</span>
				<UButton
					v-else-if="canRollBack(item)"
					color="neutral"
					variant="outline"
					size="sm"
					icon="i-lucide-undo-2"
					:aria-expanded="rollingBack === item.id"
					@click="toggle(item)"
					>Roll Back</UButton
				>
			</div>
			<SiteDeployRollback
				v-if="rollingBack === item.id && item.kind === 'release' && item.release"
				:org-id="orgId"
				:site-id="siteId"
				:release="item.release"
			/>
			<section
				v-else-if="rollingBack === item.id && item.kind === 'edit'"
				class="flex max-w-prose flex-col gap-3"
				aria-label="Roll back the edit"
			>
				<p class="text-sm text-muted">
					The files from this edit go back on the site. Only that module, theme or profile
					changes. Your content and settings stay as they are now.
				</p>
				<div class="flex flex-wrap items-center gap-3">
					<UButton
						color="error"
						:loading="busy"
						:disabled="busy"
						@click="submit(item.id)"
						>Confirm Roll Back</UButton
					>
					<UButton
						color="neutral"
						variant="outline"
						:disabled="busy"
						@click="rollingBack = null"
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
			</section>
		</li>
	</ul>
</template>
