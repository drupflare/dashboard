<template>
	<div class="flex min-h-dvh flex-col bg-muted">
		<header class="mx-auto flex w-full max-w-6xl items-center px-4 py-4">
			<NuxtLink
				to="/"
				class="rounded-md"
				aria-label="Drupflare Home"
			>
				<Logo />
			</NuxtLink>
			<div class="ml-auto">
				<ThemeToggle />
			</div>
		</header>
		<main
			id="main"
			class="flex flex-1 items-start justify-center px-4 pt-8 pb-16 sm:items-center sm:pt-0"
		>
			<div class="w-full max-w-sm rounded-lg border border-default bg-default p-6 sm:p-8">
				<slot />
			</div>
		</main>
	</div>
</template>
