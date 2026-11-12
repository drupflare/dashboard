<script setup lang="ts">
import { useOrgStore } from '~/stores/org';
import { usePlanesStore } from '~/stores/planes';

definePageMeta({ middleware: ['auth', 'org'] });

const org = useOrgStore();
const planes = usePlanesStore();
const token = ref('');

const orgId = computed(() => org.current?.id ?? null);
const message = computed(() => planes.error?.message ?? null);

async function check(accountId?: string): Promise<void> {
	if (orgId.value === null || token.value.trim() === '') return;
	await planes.probe(orgId.value, token.value.trim(), accountId);
}

function choose(accountId: string): void {
	void check(accountId);
}

onBeforeUnmount(() => {
	planes.clear();
	token.value = '';
});
</script>

<template>
	<main class="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-semibold text-highlighted">Connect Your Cloudflare Account</h1>
			<p class="text-sm text-muted">
				Paste a Cloudflare API token to see what Drupflare can use on your account. The
				check runs now. Nothing is saved and no site is created.
			</p>
		</header>
		<OnboardingSelfManagedConnect
			v-model:token="token"
			:busy="planes.probing"
			:error="message"
			@submit="check()"
		/>
		<OnboardingSelfManagedReport
			v-if="planes.report"
			:report="planes.report"
			@choose="choose"
		/>
	</main>
</template>
