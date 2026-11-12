<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { usePasskeysStore, type Passkey } from '~/stores/passkeys';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{ passkey: Passkey }>();

const passkeys = usePasskeysStore();
const session = useSessionStore();

const editing = ref(false);
const name = ref('');
const nameError = ref<string | null>(null);
const renaming = ref(false);

const removing = ref(false);
const removeError = ref<string | null>(null);
const removeBusy = ref(false);
const needsStepUp = ref(false);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const created = computed(() => new Date(props.passkey.createdAt).toLocaleDateString());
const lastUsed = computed(() =>
	props.passkey.lastUsedAt
		? `Last used ${new Date(props.passkey.lastUsedAt).toLocaleDateString()}`
		: 'Never used'
);

function startRename() {
	name.value = props.passkey.name;
	nameError.value = null;
	editing.value = true;
}

async function saveName() {
	const trimmed = name.value.trim();
	if (trimmed === '') {
		nameError.value = 'Enter a name for this passkey.';
		return;
	}
	nameError.value = null;
	renaming.value = true;
	try {
		await passkeys.rename(props.passkey.id, trimmed);
		editing.value = false;
	} catch (cause) {
		nameError.value = toApiClientError(cause).message;
	} finally {
		renaming.value = false;
	}
}

function openRemove() {
	removeError.value = null;
	needsStepUp.value = false;
	removing.value = true;
}

async function remove() {
	removeError.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	removeBusy.value = true;
	try {
		await passkeys.remove(props.passkey.id);
		removing.value = false;
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else removeError.value = failure.message;
	} finally {
		removeBusy.value = false;
	}
}

function stepUpDone() {
	needsStepUp.value = false;
	void remove();
}
</script>

<template>
	<li class="flex flex-col gap-3 p-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<span class="break-words font-medium text-highlighted">{{ passkey.name }}</span>
				<span class="text-sm text-muted">Created {{ created }}</span>
				<span class="text-sm text-muted">{{ lastUsed }}</span>
			</div>
			<div
				v-if="!editing"
				class="flex gap-2"
			>
				<UButton
					size="xs"
					color="neutral"
					variant="ghost"
					@click="startRename"
					>Rename</UButton
				>
				<UButton
					size="xs"
					color="error"
					variant="ghost"
					@click="openRemove"
					>Remove</UButton
				>
			</div>
		</div>

		<form
			v-if="editing"
			class="flex flex-col gap-3"
			@submit.prevent="saveName"
		>
			<UiField
				:id="`passkey-name-${passkey.id}`"
				label="Passkey Name"
				:error="nameError"
				v-slot="{ describedBy }"
			>
				<input
					:id="`passkey-name-${passkey.id}`"
					v-model="name"
					type="text"
					maxlength="64"
					required
					:class="inputClass"
					:aria-invalid="nameError ? 'true' : undefined"
					:aria-describedby="describedBy"
				/>
			</UiField>
			<div class="flex gap-3">
				<UButton
					type="submit"
					:loading="renaming"
					>Save Name</UButton
				>
				<UButton
					type="button"
					color="neutral"
					variant="outline"
					@click="editing = false"
					>Cancel</UButton
				>
			</div>
		</form>

		<UModal
			v-model:open="removing"
			title="Remove This Passkey?"
			:description="`${passkey.name} stops working for signing in.`"
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<p
						v-if="removeError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ removeError }}
					</p>
					<div class="flex gap-3">
						<UButton
							color="error"
							:loading="removeBusy"
							@click="remove()"
							>Remove Passkey</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							@click="removing = false"
							>Cancel</UButton
						>
					</div>
					<AccountStepUp
						v-if="needsStepUp"
						@done="stepUpDone()"
						@cancel="needsStepUp = false"
					/>
				</div>
			</template>
		</UModal>
	</li>
</template>
