<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import { providerOfState } from '~/shared/oauth';

definePageMeta({ layout: 'auth' });
useHead({ title: 'Signing In' });

type Result =
	{ status: 'signed_in' } | { status: 'link_required'; provider: string; email: string };

const route = useRoute();
const session = useSessionStore();

const phase = ref<'working' | 'link' | 'failed'>('working');
const message = ref('');
const linkEmail = ref('');

function fail(text: string) {
	message.value = text;
	phase.value = 'failed';
}

function single(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

onMounted(async () => {
	const state = single(route.query.state);
	const code = single(route.query.code);
	const error = single(route.query.error);
	const provider = state ? providerOfState(state) : null;
	if (!state || !provider || (!code && !error)) {
		fail('The sign-in link is not complete. Start again from the sign-in page.');
		return;
	}
	const query: Record<string, string> = { state };
	if (code) query.code = code;
	if (error) query.error = error;
	try {
		const result = await useApi().get<Result>(`/auth/oauth/${provider}/callback`, query);
		if (result.status === 'link_required') {
			linkEmail.value = result.email;
			phase.value = 'link';
			return;
		}
		await session.load();
		await navigateTo('/sites');
	} catch (cause) {
		fail(toApiClientError(cause).message);
	}
});
</script>

<template>
	<div class="flex flex-col gap-4">
		<template v-if="phase === 'working'">
			<h1 class="text-xl font-bold text-highlighted">Signing You In</h1>
			<p
				role="status"
				class="text-muted"
			>
				Finishing the sign-in with your provider.
			</p>
		</template>
		<template v-else-if="phase === 'link'">
			<h1 class="text-xl font-bold text-highlighted">Use Your Email Code</h1>
			<p class="text-muted">
				An account for <span class="break-all font-medium">{{ linkEmail }}</span> already
				exists. A provider sign-in never merges into an existing account, so sign in with an
				email code instead.
			</p>
			<UButton
				to="/login"
				block
				>Back to Sign In</UButton
			>
		</template>
		<template v-else>
			<h1 class="text-xl font-bold text-highlighted">Sign-In Did Not Finish</h1>
			<p
				role="alert"
				class="text-muted"
			>
				{{ message }}
			</p>
			<UButton
				to="/login"
				block
				>Back to Sign In</UButton
			>
		</template>
	</div>
</template>
