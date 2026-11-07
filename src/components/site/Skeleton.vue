<template>
	<div role="status">
		<span class="sr-only">Loading the site</span>
		<div
			aria-hidden="true"
			class="flex flex-col gap-8"
		>
			<div class="flex flex-col gap-2">
				<USkeleton class="h-8 w-64 max-w-full" />
				<USkeleton class="h-4 w-40" />
				<USkeleton class="h-4 w-56 max-w-full" />
			</div>
			<USkeleton class="h-8 w-32" />
			<div
				v-for="section in 3"
				:key="section"
				class="flex flex-col gap-3"
			>
				<USkeleton class="h-6 w-40" />
				<USkeleton class="h-16 w-full" />
			</div>
		</div>
	</div>
</template>
