<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useSiteConfigStore, type SettingChangeView } from '~/stores/site-config';

const props = defineProps<{ orgId: string; siteId: string }>();

const store = useSiteConfigStore();
const items = computed(() => store.history.get(props.siteId));
const loadError = computed(() => store.historyErrors.get(props.siteId) ?? null);

async function load(): Promise<void> {
	try {
		await store.loadHistory(props.orgId, props.siteId);
	} catch {
		// the failure is kept in the store for the list to show
	}
}

onMounted(load);

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const when = (iso: string) => dateFormat.format(new Date(iso));
const show = (value: unknown) =>
	value === null || value === undefined || value === '' ? 'Default' : String(value);

const STATUS = {
	applied: { icon: 'i-lucide-circle-check', text: 'Applied' },
	unverified: { icon: 'i-lucide-circle-alert', text: 'Not Confirmed by the Site' },
	failed: { icon: 'i-lucide-circle-x', text: 'Did Not Apply' },
	pending: { icon: 'i-lucide-loader-circle', text: 'In Progress' }
} as const;

const reverting = ref<string | null>(null);
const revertError = ref<string | null>(null);

async function revert(change: SettingChangeView): Promise<void> {
	revertError.value = null;
	reverting.value = change.id;
	try {
		const operation = await store.revert(
			props.orgId,
			props.siteId,
			change.id,
			crypto.randomUUID()
		);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		revertError.value = toApiClientError(cause).message;
	} finally {
		reverting.value = null;
	}
}
</script>

<template>
	<div class="flex flex-col gap-3">
		<UiErrorState
			v-if="loadError"
			title="Could Not Load the History"
			:text="loadError.message"
			:request-id="loadError.requestId"
		>
			<UButton
				color="neutral"
				@click="load()"
			>
				Try Again
			</UButton>
		</UiErrorState>

		<div
			v-else-if="items === undefined"
			class="flex items-center gap-2 text-sm text-muted"
		>
			<UIcon
				name="i-lucide-loader-circle"
				class="size-4 animate-spin"
			/>
			Loading History
		</div>

		<UiEmptyState
			v-else-if="items === null || items.length === 0"
			icon="i-lucide-history"
			title="No Changes Yet"
			text="Changes you make to these settings are listed here, and you can revert them."
		/>

		<template v-else>
			<p
				v-if="revertError"
				role="alert"
				class="text-sm text-error"
			>
				{{ revertError }}
			</p>
			<ul class="flex flex-col">
				<li
					v-for="change in items"
					:key="change.id"
					class="flex flex-wrap items-center justify-between gap-2 border-b border-default py-3 last:border-0"
				>
					<div class="flex flex-col gap-0.5">
						<p class="text-sm font-medium">{{ change.label }}</p>
						<p class="font-mono text-xs">
							{{ show(change.before) }} to {{ show(change.after) }}
						</p>
						<p class="text-xs text-muted">{{ when(change.createdAt) }}</p>
						<p class="inline-flex items-center gap-1 text-xs">
							<UIcon
								:name="STATUS[change.status].icon"
								class="size-3.5"
							/>
							{{ change.reverted ? 'Reverted' : STATUS[change.status].text }}
						</p>
					</div>
					<UButton
						v-if="change.revertable"
						color="neutral"
						variant="outline"
						size="sm"
						:loading="reverting === change.id"
						:disabled="reverting !== null"
						@click="revert(change)"
					>
						Revert
					</UButton>
				</li>
			</ul>
		</template>
	</div>
</template>
