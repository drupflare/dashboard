<script setup lang="ts">
import {
	startAuthentication,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import { toApiClientError, useApi } from '~/composables/useApi';
import { safeRedirect, useSessionStore } from '~/stores/session';

const route = useRoute();
const session = useSessionStore();

const supported = ref(false);
const busy = ref(false);
const notice = ref<string | null>(null);
const error = ref<string | null>(null);

onMounted(() => {
	supported.value = Boolean(window.PublicKeyCredential);
});

async function signIn() {
	notice.value = null;
	error.value = null;
	busy.value = true;
	try {
		const optionsJSON =
			await useApi().post<PublicKeyCredentialRequestOptionsJSON>('/auth/passkey/options');
		const response = await startAuthentication({ optionsJSON });
		await useApi().post('/auth/passkey/verify', { ...response });
		await session.load();
		await navigateTo(safeRedirect(route.query.redirect) ?? '/sites');
	} catch (cause) {
		if (cause instanceof Error && cause.name === 'NotAllowedError') {
			notice.value = 'No passkey was used. You can try again or sign in another way.';
		} else {
			error.value = toApiClientError(cause).message;
		}
		busy.value = false;
	}
}
</script>

<template>
	<div
		v-if="supported"
		class="flex flex-col gap-2"
	>
		<UButton
			type="button"
			color="neutral"
			variant="outline"
			block
			icon="i-lucide-fingerprint"
			:loading="busy"
			@click="signIn"
			>Sign In With a Passkey</UButton
		>
		<p
			v-if="notice"
			role="status"
			class="text-sm text-muted"
		>
			{{ notice }}
		</p>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
	</div>
</template>
