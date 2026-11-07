<script setup lang="ts">
const session = useSessionStore();
const signingOut = ref(false);

// a wrong hint settles here: the 401 clears it and the buttons fall back to signed out
onMounted(() => {
	if (session.hinted) void session.ensure();
});

async function signOut() {
	signingOut.value = true;
	await session.signOut();
	signingOut.value = false;
}
</script>

<template>
	<header class="border-b border-default">
		<div class="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
			<NuxtLink
				to="/"
				class="rounded-md"
				aria-label="Drupflare Home"
			>
				<Logo />
			</NuxtLink>
			<nav
				aria-label="Main"
				class="ml-4 hidden items-center gap-1 sm:flex"
			>
				<UButton
					to="/#how"
					color="neutral"
					variant="ghost"
					>How It Works</UButton
				>
			</nav>
			<div class="ml-auto flex items-center gap-1 sm:gap-2">
				<ThemeToggle />
				<template v-if="session.signedIn">
					<UButton
						to="/sites"
						color="neutral"
						variant="ghost"
						>Sites</UButton
					>
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-log-out"
						:loading="signingOut"
						@click="signOut"
					>
						Sign Out
					</UButton>
				</template>
				<template v-else>
					<UButton
						to="/login"
						color="neutral"
						variant="ghost"
						>Sign In</UButton
					>
					<UButton to="/new">Create a Site</UButton>
				</template>
			</div>
		</div>
	</header>
</template>
