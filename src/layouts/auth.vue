<template>
	<div class="flex min-h-dvh flex-col items-center justify-center gap-6 bg-default px-4 py-12">
		<NuxtLink
			to="/"
			class="rounded-md"
		>
			<Logo />
		</NuxtLink>
		<div class="w-full max-w-sm rounded-lg border border-default bg-default p-6">
			<slot />
		</div>
	</div>
</template>
