<script setup lang="ts">
import { useApi } from '~/composables/useApi';
import { OAUTH_CONSENT_TEXT, type OAuthProvider } from '~/shared/oauth';

// the server names the providers that have both a client id and a secret, so every button works
const providers = ref<OAuthProvider[]>([]);

onMounted(async () => {
	try {
		providers.value = (
			await useApi().get<{ providers: OAuthProvider[] }>('/auth/oauth')
		).providers;
	} catch {
		providers.value = [];
	}
});
</script>

<template>
	<div class="flex flex-col gap-6">
		<AuthMethodCode />
		<template v-if="providers.length > 0">
			<div
				class="flex items-center gap-3 text-sm text-muted"
				role="separator"
			>
				<span class="h-px flex-1 bg-accented" />
				or
				<span class="h-px flex-1 bg-accented" />
			</div>
			<div class="flex flex-col gap-3">
				<AuthMethodProvider
					v-for="provider in providers"
					:key="provider"
					:provider="provider"
				/>
				<p class="text-xs text-muted">{{ OAUTH_CONSENT_TEXT }}</p>
			</div>
		</template>
	</div>
</template>
