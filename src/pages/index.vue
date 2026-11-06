<script setup lang="ts">
definePageMeta({ layout: 'auth' });
useHead({ title: 'Drupflare' });

const session = useSessionStore();

onMounted(async () => {
	await session.ensure();
	if (session.me) await navigateTo('/sites');
});
</script>

<template>
	<ClientOnly>
		<div
			v-if="session.me === null"
			class="flex flex-col items-center gap-4 text-center"
		>
			<h1 class="text-xl font-semibold text-highlighted">Drupflare Dashboard</h1>
			<p class="text-sm text-muted">Sign in to see your sites.</p>
			<UButton
				to="/login"
				block
				>Sign In</UButton
			>
		</div>
		<UiErrorState
			v-else-if="session.error"
			title="Could Not Load Your Account"
			text="Check your connection and try again."
			:request-id="session.error.requestId"
		>
			<UButton
				color="neutral"
				@click="session.load()"
				>Try Again</UButton
			>
		</UiErrorState>
		<p
			v-else
			class="text-center text-sm text-muted"
		>
			Loading...
		</p>
		<template #fallback>
			<p class="text-center text-sm text-muted">Loading...</p>
		</template>
	</ClientOnly>
</template>
