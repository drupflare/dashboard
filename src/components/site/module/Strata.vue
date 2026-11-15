<script setup lang="ts">
import type { ModuleState } from '~/shared/modules';

// included: null while the plan loads; unlockPlan: null when no plan states Strata
const props = defineProps<{
	included: boolean | null;
	unlockPlan: string | null;
	state: ModuleState;
}>();

const statusText = computed(() => {
	if (props.state === 'verified') return 'Verified';
	if (props.state === 'untested') return 'Untested';
	return 'Blocked';
});
</script>

<template>
	<article
		class="flex flex-col gap-3 rounded-lg border border-default p-4"
		aria-labelledby="strata-title"
	>
		<div class="flex flex-wrap items-center gap-2">
			<h3
				id="strata-title"
				class="font-medium"
			>
				Strata
			</h3>
			<span class="rounded bg-elevated px-2 py-0.5 text-xs text-muted">Optional Add-On</span>
			<span class="inline-flex items-center gap-1.5 text-sm text-success">
				<UIcon
					name="i-lucide-badge-check"
					class="size-4"
					aria-hidden="true"
				/>
				{{ statusText }}
			</span>
		</div>
		<p class="text-sm text-muted">
			Strata keeps encrypted backups and instant rollback in your own S3-compatible storage.
			It works on Drupal sites only and is optional. It does not replace the platform backups.
		</p>
		<p
			v-if="included === true"
			class="text-sm"
		>
			Strata is included on this plan. It is optional, so a site runs without it.
		</p>
		<p
			v-else-if="included === false && unlockPlan"
			class="text-sm"
		>
			Strata is not included on this plan. The {{ unlockPlan }} plan includes it.
		</p>
		<p
			v-else-if="included === false"
			class="text-sm"
		>
			Strata is not included on this plan.
		</p>
	</article>
</template>
