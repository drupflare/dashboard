<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { SECRETS_NOT_CARRIED } from '~/shared/environments';
import { useEnvironmentsStore } from '~/stores/environments';

const props = defineProps<{ orgId: string; siteId: string; taken: ReadonlySet<string> }>();
const emit = defineEmits<{ close: [] }>();

const store = useEnvironmentsStore();
const kinds = [
	{ value: 'staging', label: 'Staging' },
	{ value: 'dev', label: 'Dev' },
	{ value: 'preview', label: 'Preview' }
] as const;
type Kind = (typeof kinds)[number]['value'];
const lifetimes = [
	{ hours: 24, label: '1 day' },
	{ hours: 72, label: '3 days' },
	{ hours: 168, label: '7 days' },
	{ hours: 336, label: '14 days' }
] as const;

// a site holds one staging and one dev copy, and several previews
const isTaken = (value: Kind) => value !== 'preview' && props.taken.has(value);
const kind = ref<Kind>(
	!props.taken.has('staging') ? 'staging' : !props.taken.has('dev') ? 'dev' : 'preview'
);
const hours = ref<number>(72);
const busy = ref(false);
const error = ref<string | null>(null);
const unlockedBy = ref<string | null>(null);
let request: Promise<void> | null = null;

function submit(): void {
	request ??= create().finally(() => {
		request = null;
	});
}

async function create(): Promise<void> {
	error.value = null;
	unlockedBy.value = null;
	busy.value = true;
	try {
		const key = crypto.randomUUID();
		const operation =
			kind.value === 'preview'
				? await store.createPreview(props.orgId, props.siteId, hours.value, key)
				: await store.create(props.orgId, props.siteId, kind.value, key);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { unlockedBy?: { name: string } | null } | null;
		error.value = failure.message;
		unlockedBy.value = details?.unlockedBy?.name ?? null;
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
		title="Create an Environment"
		description="Make a copy of this site from its newest backup, to try changes before they go live."
		@update:open="onOpenChange"
	>
		<template #body>
			<form
				class="flex flex-col gap-4"
				@submit.prevent="submit()"
			>
				<fieldset class="flex flex-col gap-2">
					<legend class="text-sm font-medium text-highlighted">Kind</legend>
					<label
						v-for="option in kinds"
						:key="option.value"
						class="flex items-center gap-3 text-sm text-default"
					>
						<input
							v-model="kind"
							type="radio"
							name="environment-kind"
							class="size-4 accent-primary"
							:value="option.value"
							:disabled="isTaken(option.value)"
						/>
						<span
							>{{ option.label }}
							<span
								v-if="isTaken(option.value)"
								class="text-muted"
								>(this site already has one)</span
							></span
						>
					</label>
				</fieldset>

				<label
					v-if="kind === 'preview'"
					class="flex flex-col gap-1 text-sm text-default"
				>
					<span class="font-medium text-highlighted">Keep it for</span>
					<select
						v-model.number="hours"
						class="rounded-md border border-default bg-default px-3 py-2"
					>
						<option
							v-for="option in lifetimes"
							:key="option.hours"
							:value="option.hours"
						>
							{{ option.label }}
						</option>
					</select>
					<span class="text-muted"
						>A preview is deleted on its own when this time runs out.</span
					>
				</label>

				<div class="flex flex-col gap-2 text-sm text-default">
					<p class="font-medium text-highlighted">What stays behind</p>
					<p>The copy gets its own owner token. These must be set again on the copy:</p>
					<ul class="list-inside list-disc">
						<li
							v-for="item in SECRETS_NOT_CARRIED"
							:key="item"
						>
							{{ item }}
						</li>
					</ul>
				</div>

				<div
					v-if="error"
					role="alert"
					class="flex flex-col gap-1 text-sm text-red-700 dark:text-red-400"
				>
					<p>{{ error }}</p>
					<p v-if="unlockedBy">
						The {{ unlockedBy }} plan includes them.
						<NuxtLink
							to="/org/billing"
							class="underline"
							>See Plans</NuxtLink
						>
					</p>
				</div>

				<div class="flex gap-3">
					<UButton
						type="submit"
						:loading="busy"
						:disabled="busy || isTaken(kind)"
						>Create Environment</UButton
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
