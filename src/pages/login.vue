<script setup lang="ts">
import { safeRedirect } from '~/stores/session';

definePageMeta({ layout: 'auth' });
useHead({ title: 'Sign In' });

const route = useRoute();
const session = useSessionStore();

onMounted(async () => {
	await session.ensure();
	if (session.me) await navigateTo(safeRedirect(route.query.redirect) ?? '/sites');
});
</script>

<template>
	<div class="flex flex-col gap-6">
		<h1 class="text-xl font-semibold text-highlighted">Sign In</h1>
		<AuthMethods />
	</div>
</template>
