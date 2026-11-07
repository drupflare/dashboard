<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';

const emit = defineEmits<{ done: []; cancel: [] }>();

const session = useSessionStore();

const step = ref<'ask' | 'code'>('ask');
const code = ref('');
const token = ref<string | undefined>();
const turnstile = ref<{ reset: () => void } | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

async function send() {
	error.value = null;
	busy.value = true;
	try {
		await useApi().post('/auth/code/request', {
			email: session.me?.email,
			turnstileToken: token.value
		});
		step.value = 'code';
		code.value = '';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
		token.value = undefined;
		turnstile.value?.reset();
	}
}

async function confirm() {
	error.value = null;
	if (!/^\d{6}$/.test(code.value)) {
		error.value = 'Enter the six-digit code from your email.';
		return;
	}
	busy.value = true;
	try {
		await useApi().post('/auth/step-up', { code: code.value });
		await session.load();
		emit('done');
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form
		class="flex max-w-md flex-col gap-4 rounded-lg border border-default p-4"
		@submit.prevent="step === 'ask' ? send() : confirm()"
	>
		<div class="flex flex-col gap-1">
			<h3 class="font-semibold text-highlighted">Confirm Your Identity</h3>
			<p class="text-sm text-muted">
				This change needs a fresh sign-in. We email a six-digit code to
				{{ session.me?.email }}.
			</p>
		</div>
		<template v-if="step === 'ask'">
			<NuxtTurnstile
				ref="turnstile"
				v-model="token"
			/>
		</template>
		<UiField
			v-else
			id="step-up-code"
			label="Six-Digit Code"
			:error="error"
			v-slot="{ describedBy }"
		>
			<input
				id="step-up-code"
				v-model="code"
				type="text"
				inputmode="numeric"
				autocomplete="one-time-code"
				maxlength="6"
				required
				:class="inputClass"
				:aria-invalid="error ? 'true' : undefined"
				:aria-describedby="describedBy"
			/>
		</UiField>
		<p
			v-if="step === 'ask' && error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<div class="flex gap-3">
			<UButton
				type="submit"
				:loading="busy"
				>{{ step === 'ask' ? 'Send Code' : 'Confirm' }}</UButton
			>
			<UButton
				type="button"
				color="neutral"
				variant="outline"
				@click="emit('cancel')"
				>Cancel</UButton
			>
		</div>
	</form>
</template>
