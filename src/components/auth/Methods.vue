<script setup lang="ts">
import { useApi } from '~/composables/useApi';
import { CLOUDFLARE_CONSENT_TEXT, OAUTH_CONSENT_TEXT, type OAuthProvider } from '~/shared/oauth';

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
				<p
					v-if="providers.some((provider) => provider !== 'cloudflare')"
					class="text-xs text-muted"
				>
					{{ OAUTH_CONSENT_TEXT }}
				</p>
				<p
					v-if="providers.includes('cloudflare')"
					class="text-xs text-muted"
				>
					{{ CLOUDFLARE_CONSENT_TEXT }} Connect Cloudflare from the Account page before
					you sign in with it.
				</p>
			</div>
		</template>
	</div>
</template>
