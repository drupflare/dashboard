<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { SECRETS_NOT_CARRIED } from '~/shared/environments';
import { useEnvironmentsStore } from '~/stores/environments';

const props = defineProps<{ orgId: string; siteId: string; taken: ReadonlySet<string> }>();
const emit = defineEmits<{ close: [] }>();

const store = useEnvironmentsStore();
const kinds = [
	{ value: 'staging', label: 'Staging' },
	{ value: 'dev', label: 'Dev' }
] as const;
const kind = ref<'staging' | 'dev'>(props.taken.has('staging') ? 'dev' : 'staging');
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
		const operation = await store.create(
			props.orgId,
			props.siteId,
			kind.value,
			crypto.randomUUID()
		);
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
							:disabled="taken.has(option.value)"
						/>
						<span
							>{{ option.label }}
							<span
								v-if="taken.has(option.value)"
								class="text-muted"
								>(this site already has one)</span
							></span
						>
					</label>
				</fieldset>

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
						:disabled="busy || taken.has(kind)"
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
