<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import type { OAuthProvider } from '~/shared/oauth';

const props = defineProps<{ provider: OAuthProvider }>();

const NAMES: Record<OAuthProvider, { label: string; icon: string }> = {
	github: { label: 'GitHub', icon: 'i-lucide-github' },
	gitlab: { label: 'GitLab', icon: 'i-lucide-gitlab' },
	google: { label: 'Google', icon: 'i-lucide-log-in' },
	microsoft: { label: 'Microsoft', icon: 'i-lucide-log-in' }
};

const meta = computed(() => NAMES[props.provider]);
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
			:icon="meta.icon"
			:loading="busy"
			@click="start"
		>
			Continue with {{ meta.label }}
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
