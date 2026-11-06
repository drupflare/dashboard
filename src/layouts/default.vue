<template>
	<div class="min-h-dvh bg-default text-default">
		<a
			href="#main"
			class="sr-only rounded-md bg-default px-3 py-2 focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10"
		>
			Skip to Content
		</a>
		<NavBar />
		<div class="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row">
			<SideNav />
			<main
				id="main"
				class="min-w-0 flex-1"
			>
				<slot />
			</main>
		</div>
	</div>
</template>
