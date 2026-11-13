<script setup lang="ts">
import { LEAVES_THE_BOX, NEVER_LEAVES_THE_BOX } from '@contracts/fleet-link';
import { toApiClientError } from '~/composables/useApi';
import { pairLine, type PairingView } from '~/shared/nodes';
import { useNodesStore } from '~/stores/nodes';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{ orgId: string }>();
const emit = defineEmits<{ closed: [] }>();

const nodes = useNodesStore();
const session = useSessionStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
const pairing = ref<PairingView | null>(null);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

const line = computed(() => (pairing.value ? pairLine(pairing.value.pairUrl) : ''));
const expires = computed(() =>
	pairing.value
		? new Date(pairing.value.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' })
		: ''
);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show(): void {
	error.value = null;
	needsStepUp.value = false;
	pairing.value = null;
	copyState.value = 'idle';
	open.value = true;
}

// the token lives only in this component while the dialog is open
watch(open, (value) => {
	if (value) return;
	const created = pairing.value !== null;
	pairing.value = null;
	copyState.value = 'idle';
	void nextTick(() => trigger.value?.$el.focus());
	if (created) emit('closed');
});

async function create(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		pairing.value = await nodes.pair(props.orgId);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else error.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void create();
}

async function copy(): Promise<void> {
	try {
		await navigator.clipboard.writeText(line.value);
		copyState.value = 'copied';
	} catch {
		copyState.value = 'failed';
	}
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			icon="i-lucide-plus"
			@click="show()"
			>Pair a Node</UButton
		>
		<UModal
			v-model:open="open"
			title="Pair a Node"
			description="Link a box that runs Bastion to this organization."
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<section class="flex flex-col gap-2">
						<h3 class="font-semibold text-highlighted">What Leaves Your Box</h3>
						<details class="text-sm text-default">
							<summary class="cursor-pointer text-muted">
								The full list of what the box reports
							</summary>
							<ul class="mt-2 flex list-disc flex-col gap-1 pl-5">
								<li
									v-for="item in LEAVES_THE_BOX"
									:key="`${item.type}.${item.field}`"
								>
									{{ item.description }}
								</li>
							</ul>
						</details>
						<p class="text-sm text-default">
							Never leaves your box: {{ NEVER_LEAVES_THE_BOX.join(', ') }}.
						</p>
					</section>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<template v-if="pairing === null">
						<div v-if="!needsStepUp">
							<UButton
								:loading="busy"
								@click="create()"
								>Create Pairing</UButton
							>
						</div>
						<AccountStepUp
							v-else
							@done="stepUpDone()"
							@cancel="needsStepUp = false"
						/>
					</template>

					<section
						v-else
						class="flex flex-col gap-3"
					>
						<p class="text-sm text-default">
							Run this on the box. It works once and expires at {{ expires }}.
						</p>
						<p
							class="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
						>
							<UIcon
								name="i-lucide-triangle-alert"
								class="mt-0.5 size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>This command will not be shown again. Copy it now.</span>
						</p>
						<code
							class="break-all rounded-md bg-elevated px-3 py-2 text-sm text-highlighted select-all"
							>{{ line }}</code
						>
						<div class="flex flex-wrap items-center gap-3">
							<UButton
								color="neutral"
								variant="outline"
								icon="i-lucide-copy"
								@click="copy()"
							>
								Copy Command
							</UButton>
							<span
								role="status"
								class="text-sm text-muted"
							>
								<template v-if="copyState === 'copied'">Copied</template>
								<template v-else-if="copyState === 'failed'"
									>Copy Failed. Select the command and copy it.</template
								>
							</span>
						</div>
					</section>
				</div>
			</template>
		</UModal>
	</div>
</template>
