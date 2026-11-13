<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	KEY_EXPIRY_LABELS,
	KEY_EXPIRY_PRESETS,
	type KeyCreated,
	type KeyExpiry
} from '~/shared/api-keys';
import { useApiKeysStore } from '~/stores/api-keys';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{ orgId: string; offered: readonly string[] }>();
const emit = defineEmits<{ closed: [] }>();

const keys = useApiKeysStore();
const session = useSessionStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const name = ref('');
const expiry = ref<KeyExpiry>('90d');
const scopes = ref<string[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
const created = ref<KeyCreated | null>(null);

const expiryItems = KEY_EXPIRY_PRESETS.map((value) => ({
	label: KEY_EXPIRY_LABELS[value],
	value
}));
const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show(): void {
	name.value = '';
	expiry.value = '90d';
	scopes.value = [];
	error.value = null;
	needsStepUp.value = false;
	created.value = null;
	open.value = true;
}

// the token lives only in this component while the dialog is open
watch(open, (value) => {
	if (value) return;
	const made = created.value !== null;
	created.value = null;
	void nextTick(() => trigger.value?.$el.focus());
	if (made) emit('closed');
});

async function submit(): Promise<void> {
	error.value = null;
	if (name.value.trim() === '') {
		error.value = 'Give the key a name so you can tell it apart later.';
		return;
	}
	if (scopes.value.length === 0) {
		error.value = 'Pick at least one permission for the key.';
		return;
	}
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		created.value = await keys.create(props.orgId, {
			name: name.value.trim(),
			scopes: scopes.value,
			expiry: expiry.value
		});
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
	void submit();
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			icon="i-lucide-plus"
			@click="show()"
			>Create a Key</UButton
		>
		<UModal
			v-model:open="open"
			title="Create a Key"
			description="Give a script or an AI client access to this organization."
		>
			<template #body>
				<KeyCreateReveal
					v-if="created"
					:created="created"
				/>
				<AccountStepUp
					v-else-if="needsStepUp"
					@done="stepUpDone()"
					@cancel="needsStepUp = false"
				/>
				<form
					v-else
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<UiField
						id="key-name"
						label="Name"
						hint="Say what the key is for, such as Claude Code on my laptop."
						v-slot="{ describedBy }"
					>
						<input
							id="key-name"
							v-model="name"
							type="text"
							maxlength="64"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>

					<UFormField label="Expires After">
						<USelect
							v-model="expiry"
							:items="expiryItems"
							class="w-full"
						/>
					</UFormField>

					<fieldset class="flex flex-col gap-2">
						<legend class="text-sm font-medium text-default">Permissions</legend>
						<p class="text-sm text-muted">
							A key can hold only permissions you hold yourself, and it loses one if
							you lose it. Some actions always need you signed in, so no key can do
							them.
						</p>
						<KeyCreateScopes
							v-model="scopes"
							:offered="offered"
						/>
					</fieldset>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="busy"
							>Create Key</UButton
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
			</template>
		</UModal>
	</div>
</template>
