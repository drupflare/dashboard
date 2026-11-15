<script setup lang="ts">
defineProps<{ planName: string | null }>();
</script>

<template>
	<section
		class="flex flex-col gap-3 rounded-lg border border-default p-4"
		aria-labelledby="custom-upgrade"
	>
		<h3
			id="custom-upgrade"
			class="text-base font-semibold text-highlighted"
		>
			Your Plan Does Not Include Your Own Code
		</h3>
		<p class="text-sm text-default">
			<template v-if="planName">
				Uploading a built Worker is part of the {{ planName }} plan.
			</template>
			<template v-else>Uploading a built Worker needs a paid plan.</template>
			Nothing was stored.
		</p>
		<div>
			<UButton
				to="/org/billing"
				color="primary"
				variant="solid"
			>
				See Plans
			</UButton>
		</div>
	</section>
</template>
