<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { NodeView } from '~/shared/nodes';
import { useNodesStore } from '~/stores/nodes';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{ orgId: string; node: NodeView }>();

const nodes = useNodesStore();
const session = useSessionStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show(): void {
	error.value = null;
	needsStepUp.value = false;
	open.value = true;
}

// some browsers do not focus a button on click, so the dialog cannot rely on the last focus
watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function revoke(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		await nodes.revoke(props.orgId, props.node.id);
		open.value = false;
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
	void revoke();
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			color="error"
			variant="outline"
			icon="i-lucide-unplug"
			@click="show()"
			>Revoke</UButton
		>
		<UModal
			v-model:open="open"
			title="Revoke This Node"
			:description="`Cut the link to ${node.name}.`"
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-2 text-sm text-default">
						<p>
							The dashboard stops accepting anything from this node and sends it
							nothing.
						</p>
						<p>
							The box keeps running on its own, with the sites it already hosts. To
							link it again, start a new pairing.
						</p>
					</div>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<UiConfirmTyped
						:expected="node.name"
						label="Node Name"
						action="Revoke Node"
						:busy="busy"
						@confirm="revoke()"
						@cancel="open = false"
					/>

					<AccountStepUp
						v-if="needsStepUp"
						@done="stepUpDone()"
						@cancel="needsStepUp = false"
					/>
				</div>
			</template>
		</UModal>
	</div>
</template>
