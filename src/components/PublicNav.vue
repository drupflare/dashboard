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
				<UButton
					to="/login"
					color="neutral"
					variant="ghost"
					>Sign In</UButton
				>
				<UButton to="/login">Create a Site</UButton>
			</div>
		</div>
	</header>
</template>
