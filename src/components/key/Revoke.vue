<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { keyUsedRecently, type KeyView } from '~/shared/api-keys';
import { useApiKeysStore } from '~/stores/api-keys';

const props = defineProps<{ orgId: string; apiKey: KeyView }>();

const keys = useApiKeysStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const busy = ref(false);
const error = ref<string | null>(null);
// asked when the dialog opens, so a key used while it is open does not change the form under the person
const inUse = ref(false);

function show(): void {
	error.value = null;
	inUse.value = keyUsedRecently(props.apiKey, Date.now());
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function revoke(): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		await keys.revoke(props.orgId, props.apiKey.id);
		open.value = false;
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			color="error"
			variant="outline"
			size="sm"
			icon="i-lucide-ban"
			@click="show()"
			>Revoke</UButton
		>
		<UModal
			v-model:open="open"
			title="Revoke This Key"
			:description="`Stop ${apiKey.name} from working.`"
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<p class="text-sm text-default">
						The next request that uses this key is refused. You cannot undo this. To get
						access back, create a new key.
					</p>
					<p
						v-if="inUse"
						class="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
					>
						<UIcon
							name="i-lucide-triangle-alert"
							class="mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
						<span
							>This key was used in the last day. Something may still rely on
							it.</span
						>
					</p>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<UiConfirmTyped
						v-if="inUse"
						:expected="apiKey.name"
						label="Key Name"
						action="Revoke Key"
						:busy="busy"
						@confirm="revoke()"
						@cancel="open = false"
					/>
					<div
						v-else
						class="flex gap-3"
					>
						<UButton
							color="error"
							:loading="busy"
							@click="revoke()"
							>Revoke Key</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							@click="open = false"
							>Cancel</UButton
						>
					</div>
				</div>
			</template>
		</UModal>
	</div>
</template>
