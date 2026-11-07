<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import { OAUTH_LABELS, type OAuthProvider } from '~/shared/oauth';

const props = defineProps<{ provider: OAuthProvider }>();

const ICONS: Record<OAuthProvider, string> = {
	github: 'i-lucide-github',
	gitlab: 'i-lucide-gitlab',
	cloudflare: 'i-lucide-cloud',
	google: 'i-lucide-log-in',
	microsoft: 'i-lucide-log-in'
};

const label = computed(() => OAUTH_LABELS[props.provider]);
const busy = ref(false);
const error = ref<string | null>(null);

async function start() {
	busy.value = true;
	error.value = null;
	try {
		const { url } = await useApi().get<{ url: string }>(`/auth/oauth/${props.provider}/start`);
		window.location.assign(url);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		busy.value = false;
	}
}
</script>

<template>
	<div class="flex flex-col gap-2">
		<UButton
			type="button"
			color="neutral"
			variant="outline"
			block
			:icon="ICONS[provider]"
			:loading="busy"
			@click="start"
		>
			Continue with {{ label }}
		</UButton>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
	</div>
</template>
