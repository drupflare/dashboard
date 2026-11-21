<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	KEY_EXPIRY_LABELS,
	KEY_EXPIRY_PRESETS,
	type KeyCreated,
	type KeyExpiry
} from '~/shared/api-keys';
import { useServiceAccountsStore } from '~/stores/service-accounts';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{
	orgId: string;
	accountId: string;
	accountName: string;
	offered: readonly string[];
}>();

const store = useServiceAccountsStore();
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
	created.value = null;
	void nextTick(() => trigger.value?.$el.focus());
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
		created.value = await store.issueKey(props.orgId, props.accountId, {
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
			size="sm"
			icon="i-lucide-key-round"
			:aria-label="`New key for ${accountName}`"
			@click="show()"
			>New Key</UButton
		>
		<UModal
			v-model:open="open"
			title="Create a Key"
			:description="`A key for ${accountName}. It can hold only permissions its owner holds, and it never outlives the account.`"
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
						id="account-key-name"
						label="Name"
						v-slot="{ describedBy }"
					>
						<input
							id="account-key-name"
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
							The list shows what you hold. If the owner holds less, the dashboard
							refuses the extra ones and says which.
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
