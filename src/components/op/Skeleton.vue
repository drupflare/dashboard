<template>
	<div role="status">
		<span class="sr-only">Loading the operation</span>
		<div
			aria-hidden="true"
			class="flex flex-col gap-6"
		>
			<USkeleton class="h-5 w-28" />
			<div
				class="flex flex-col divide-y divide-default rounded-lg border border-default px-4"
			>
				<div
					v-for="step in 4"
					:key="step"
					class="flex items-center gap-3 py-3"
				>
					<USkeleton class="h-4 w-20" />
					<USkeleton class="h-4 w-48 max-w-full" />
				</div>
			</div>
		</div>
	</div>
</template>
