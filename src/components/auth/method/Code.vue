<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import { safeRedirect } from '~/stores/session';

const route = useRoute();
const session = useSessionStore();

const step = ref<'email' | 'code'>('email');
const email = ref('');
const code = ref('');
const token = ref<string | undefined>();
const turnstile = ref<{ reset: () => void } | null>(null);
const codeInput = ref<HTMLInputElement | null>(null);
const emailError = ref<string | null>(null);
const codeError = ref<string | null>(null);
const busy = ref(false);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

type Details = {
	retryAfterSeconds?: number;
	issues?: { message: string }[];
};

function messageFor(error: unknown): string {
	const apiError = toApiClientError(error);
	const details = apiError.details as Details | null;
	if (apiError.code === 'rate_limited' && details?.retryAfterSeconds) {
		return `${apiError.message}. Try again in ${details.retryAfterSeconds} seconds.`;
	}
	if (apiError.code === 'validation' && details?.issues?.[0]) return details.issues[0].message;
	return apiError.message;
}

async function requestCode() {
	emailError.value = null;
	codeError.value = null;
	busy.value = true;
	try {
		await useApi().post('/auth/code/request', {
			email: email.value,
			turnstileToken: token.value
		});
		step.value = 'code';
		code.value = '';
		await nextTick();
		codeInput.value?.focus();
	} catch (error) {
		if (step.value === 'email') emailError.value = messageFor(error);
		else codeError.value = messageFor(error);
	} finally {
		busy.value = false;
		token.value = undefined;
		turnstile.value?.reset();
	}
}

async function verify() {
	codeError.value = null;
	if (!/^\d{6}$/.test(code.value)) {
		codeError.value = 'Enter the six-digit code from your email.';
		return;
	}
	busy.value = true;
	try {
		await useApi().post('/auth/code/verify', { email: email.value, code: code.value });
		await session.load();
		await navigateTo(safeRedirect(route.query.redirect) ?? '/sites');
	} catch (error) {
		codeError.value = messageFor(error);
	} finally {
		busy.value = false;
	}
}

function changeEmail() {
	step.value = 'email';
	codeError.value = null;
}
</script>

<template>
	<div class="flex flex-col gap-6">
		<form
			v-if="step === 'email'"
			class="flex flex-col gap-5"
			@submit.prevent="requestCode"
		>
			<p class="text-sm text-muted">
				We will email you a six-digit sign-in code. A new address gets an account once the
				code is verified.
			</p>
			<UiField
				id="sign-in-email"
				label="Email Address"
				:error="emailError"
				v-slot="{ describedBy }"
			>
				<input
					id="sign-in-email"
					v-model="email"
					type="email"
					name="email"
					autocomplete="email"
					required
					:class="inputClass"
					:aria-invalid="emailError ? 'true' : undefined"
					:aria-describedby="describedBy"
				/>
			</UiField>
			<NuxtTurnstile
				ref="turnstile"
				v-model="token"
			/>
			<UButton
				type="submit"
				block
				:loading="busy"
				>Send Code</UButton
			>
		</form>

		<form
			v-else
			class="flex flex-col gap-5"
			@submit.prevent="verify"
		>
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold text-highlighted">Check Your Email</h2>
				<p class="text-sm text-muted">
					Enter the six-digit code sent to
					<span class="break-all font-medium">{{ email }}</span
					>.
				</p>
			</div>
			<UiField
				id="sign-in-code"
				label="Six-Digit Code"
				:error="codeError"
				v-slot="{ describedBy }"
			>
				<input
					id="sign-in-code"
					ref="codeInput"
					v-model="code"
					type="text"
					name="code"
					inputmode="numeric"
					autocomplete="one-time-code"
					maxlength="6"
					required
					:class="inputClass"
					:aria-invalid="codeError ? 'true' : undefined"
					:aria-describedby="describedBy"
				/>
			</UiField>
			<UButton
				type="submit"
				block
				:loading="busy"
				>Verify Code</UButton
			>
			<div class="flex flex-wrap justify-between gap-3">
				<UButton
					type="button"
					color="neutral"
					variant="ghost"
					:disabled="busy"
					@click="requestCode"
				>
					Send a New Code
				</UButton>
				<UButton
					type="button"
					color="neutral"
					variant="ghost"
					:disabled="busy"
					@click="changeEmail"
				>
					Use a Different Email
				</UButton>
			</div>
			<NuxtTurnstile
				ref="turnstile"
				v-model="token"
			/>
		</form>
	</div>
</template>
