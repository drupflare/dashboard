<script setup lang="ts">
import type { PlanEntitlement } from '~/stores/billing';

const props = defineProps<{
	planName: string | null;
	entitlement: PlanEntitlement;
	addOnNames: string[];
	subscribed: boolean;
	canPortal: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ manage: [] }>();

const limit = (value: number | null) => (value === null ? 'Not Stated' : String(value));
</script>

<template>
	<section class="flex flex-col gap-4 rounded-lg border border-default p-5">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold text-highlighted">Current Plan</h2>
				<p class="text-xl font-bold text-highlighted">
					{{ planName ?? 'Plan Not Listed' }}
				</p>
			</div>
			<UButton
				v-if="subscribed && canPortal"
				:loading="busy === 'portal'"
				:disabled="busy !== null"
				@click="emit('manage')"
			>
				Manage Billing
			</UButton>
		</div>

		<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:max-w-md">
			<dt class="text-muted">Sites</dt>
			<dd class="text-highlighted">{{ limit(entitlement.sites) }}</dd>
			<dt class="text-muted">Views</dt>
			<dd class="text-highlighted">{{ limit(entitlement.views) }}</dd>
			<dt class="text-muted">Add-ons</dt>
			<dd class="text-highlighted">
				{{ addOnNames.length ? addOnNames.join(', ') : 'None' }}
			</dd>
		</dl>

		<p
			v-if="!canPortal"
			class="text-sm text-muted"
		>
			Only organization owners and billing members can change billing.
		</p>
	</section>
</template>
