<template>
	<div role="status">
		<span class="sr-only">Loading the admin area</span>
		<div
			aria-hidden="true"
			class="flex flex-col gap-6"
		>
			<div class="flex flex-col gap-2">
				<USkeleton class="h-9 w-32" />
				<USkeleton class="h-5 w-80 max-w-full" />
			</div>
			<div class="flex gap-4">
				<USkeleton
					v-for="tab in 6"
					:key="tab"
					class="h-8 w-24"
				/>
			</div>
			<div class="flex max-w-md flex-col gap-3">
				<USkeleton
					v-for="line in 2"
					:key="line"
					class="h-6 w-full"
				/>
			</div>
		</div>
	</div>
</template>
