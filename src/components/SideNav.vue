<template>
	<nav
		aria-label="Main"
		class="flex gap-1 overflow-x-auto md:w-48 md:flex-col md:overflow-visible"
	>
		<NuxtLink
			to="/sites"
			class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-default hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
			active-class="bg-elevated"
		>
			<UIcon
				name="i-lucide-globe"
				class="size-4"
				aria-hidden="true"
			/>
			Sites
		</NuxtLink>
	</nav>
</template>
