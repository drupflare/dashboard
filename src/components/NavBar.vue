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
		<div class="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
			<NuxtLink
				to="/sites"
				class="rounded-md"
			>
				<Logo />
			</NuxtLink>
			<div class="ml-auto flex flex-wrap items-center gap-3">
				<ClientOnly>
					<OrgSwitcher v-if="session.signedIn" />
					<template #fallback>
						<USkeleton
							v-if="session.signedIn"
							class="h-8 w-72"
							aria-hidden="true"
						/>
					</template>
				</ClientOnly>
				<UButton
					v-if="session.signedIn"
					color="neutral"
					variant="ghost"
					icon="i-lucide-log-out"
					:loading="signingOut"
					@click="signOut"
				>
					Sign Out
				</UButton>
				<ThemeToggle />
			</div>
		</div>
	</header>
</template>
