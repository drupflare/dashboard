<template>
	<div role="status">
		<span class="sr-only">Loading your account</span>
		<div
			aria-hidden="true"
			class="flex max-w-3xl flex-col gap-10"
		>
			<div class="flex flex-col gap-2">
				<USkeleton class="h-9 w-40" />
				<USkeleton class="h-5 w-56" />
			</div>
			<div class="flex flex-col gap-4">
				<USkeleton class="h-6 w-32" />
				<div class="grid gap-3 sm:grid-cols-3">
					<USkeleton
						v-for="card in 3"
						:key="card"
						class="h-20"
					/>
				</div>
			</div>
			<div class="flex flex-col gap-4">
				<USkeleton class="h-6 w-40" />
				<USkeleton class="h-16 w-full" />
			</div>
			<div class="flex flex-col gap-4">
				<USkeleton class="h-6 w-24" />
				<USkeleton class="h-5 w-full max-w-prose" />
				<USkeleton class="h-9 w-28" />
			</div>
		</div>
	</div>
</template>
