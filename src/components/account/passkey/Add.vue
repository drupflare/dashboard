<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { usePasskeysStore } from '~/stores/passkeys';
import { useSessionStore } from '~/stores/session';

const passkeys = usePasskeysStore();
const session = useSessionStore();

const open = ref(false);
const name = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const needsStepUp = ref(false);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show() {
	name.value = '';
	error.value = null;
	notice.value = null;
	needsStepUp.value = false;
	open.value = true;
}

async function add() {
	error.value = null;
	notice.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		await passkeys.register(name.value);
		open.value = false;
	} catch (cause) {
		if (cause instanceof Error && cause.name === 'NotAllowedError') {
			notice.value = 'No passkey was added.';
		} else {
			const failure = toApiClientError(cause);
			const details = failure.details as { requires?: string } | null;
			if (details?.requires === 'step-up') needsStepUp.value = true;
			else error.value = failure.message;
		}
	} finally {
		busy.value = false;
	}
}

function stepUpDone() {
	needsStepUp.value = false;
	void add();
}
</script>

<template>
	<div>
		<UButton
			icon="i-lucide-plus"
			@click="show()"
			>Add a Passkey</UButton
		>
		<UModal
			v-model:open="open"
			title="Add a Passkey"
			description="Your device or password manager creates the passkey. Follow its prompts to finish."
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<form
						class="flex flex-col gap-4"
						@submit.prevent="add()"
					>
						<UiField
							id="passkey-add-name"
							label="Passkey Name"
							hint="Optional. It helps you tell passkeys apart."
							:error="error"
							v-slot="{ describedBy }"
						>
							<input
								id="passkey-add-name"
								v-model="name"
								type="text"
								maxlength="64"
								:class="inputClass"
								:aria-invalid="error ? 'true' : undefined"
								:aria-describedby="describedBy"
							/>
						</UiField>
						<p
							v-if="notice"
							role="status"
							class="text-sm text-muted"
						>
							{{ notice }}
						</p>
						<div class="flex gap-3">
							<UButton
								type="submit"
								:loading="busy"
								>Add Passkey</UButton
							>
							<UButton
								type="button"
								color="neutral"
								variant="outline"
								@click="open = false"
								>Cancel</UButton
							>
						</div>
					</form>
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
