<template>
	<div class="flex min-h-dvh flex-col bg-default text-default">
		<a
			href="#main"
			class="sr-only rounded-md bg-default px-3 py-2 focus:not-sr-only focus:block focus:px-3 focus:py-2"
		>
			Skip to Content
		</a>
		<PublicNav />
		<main
			id="main"
			class="flex-1"
		>
			<slot />
		</main>
		<PublicFooter />
	</div>
</template>
