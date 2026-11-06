<script setup lang="ts">
const session = useSessionStore();
const signingOut = ref(false);

async function signOut() {
	signingOut.value = true;
	await session.signOut();
	signingOut.value = false;
	if (session.me === null) await navigateTo('/login');
}
</script>

<template>
	<header class="border-b border-default bg-default">
		<div class="flex flex-wrap items-center gap-4 px-4 py-3">
			<NuxtLink
				to="/sites"
				class="rounded-md"
			>
				<Logo />
			</NuxtLink>
			<div class="ml-auto flex flex-wrap items-center gap-3">
				<ClientOnly>
					<OrgSwitcher v-if="session.me" />
					<UButton
						v-if="session.me"
						color="neutral"
						variant="ghost"
						icon="i-lucide-log-out"
						:loading="signingOut"
						@click="signOut"
					>
						Sign Out
					</UButton>
				</ClientOnly>
				<ThemeToggle />
			</div>
		</div>
	</header>
</template>
