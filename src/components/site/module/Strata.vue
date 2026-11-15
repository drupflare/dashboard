<script setup lang="ts">
import type { ModuleState } from '~/shared/modules';
import {
	STRATA_ALLOCATIONS,
	STRATA_ALLOCATION_LABELS,
	STRATA_ALLOCATION_TEXT,
	STRATA_FREE_WARNING,
	STRATA_STORAGE_NOTES,
	STRATA_STORE_REASONS,
	allocationAllowed,
	type StrataAllocation,
	type StrataStatus,
	type StrataStoreReason
} from '~/shared/strata';

// included: null while the plan loads; unlockPlan: null when no plan states Strata
const props = defineProps<{
	included: boolean | null;
	unlockPlan: string | null;
	state: ModuleState;
	free: boolean;
	status: StrataStatus | null;
	saving?: boolean;
	error?: string | null;
	// null while the site loads; false for a self-managed site
	managed?: boolean | null;
}>();

const emit = defineEmits<{
	start: [];
	allocate: [allocation: StrataAllocation];
	retryStore: [];
}>();

const storeReason = computed(() => {
	const reason = props.status?.storeReason;
	return reason != null && reason in STRATA_STORE_REASONS
		? STRATA_STORE_REASONS[reason as StrataStoreReason]
		: '';
});

const storageNote = computed(() => {
	const check = props.status?.storage;
	return check == null || check === 'ok' ? null : STRATA_STORAGE_NOTES[check];
});

const confirming = ref(false);

const statusText = computed(() => {
	if (props.state === 'verified') return 'Verified';
	if (props.state === 'untested') return 'Untested';
	return 'Blocked';
});

const confirmed = computed(() => props.status?.confirmedFreeAt != null);

function begin(): void {
	if (props.free && !confirmed.value) {
		confirming.value = true;
		return;
	}
	emit('start');
}

function proceed(): void {
	confirming.value = false;
	emit('start');
}
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
			Strata keeps encrypted backups and instant rollback in S3-compatible storage. It works
			on Drupal sites only and is optional. It does not replace the platform backups.
		</p>
		<template v-if="included === true">
			<p class="text-sm">
				Strata is included on this plan. It is optional, so a site runs without it.
			</p>

			<div
				v-if="confirming"
				class="flex flex-col gap-3 rounded-lg border border-warning p-3"
				role="alertdialog"
				aria-labelledby="strata-warning-title"
				data-test="strata-free-warning"
			>
				<h4
					id="strata-warning-title"
					class="text-sm font-medium"
				>
					Strata Uses the Free Daily Allowance
				</h4>
				<p class="text-sm">{{ STRATA_FREE_WARNING }}</p>
				<p class="text-sm">
					Strata starts on the Light setting, which saves history every 15 minutes. You
					can turn Strata off at any time.
				</p>
				<div class="flex gap-3">
					<UButton @click="proceed">Turn On Strata</UButton>
					<UButton
						color="neutral"
						variant="outline"
						@click="confirming = false"
						>Cancel</UButton
					>
				</div>
			</div>
			<div v-else>
				<UButton
					color="neutral"
					variant="outline"
					@click="begin"
					>Set Up Strata</UButton
				>
			</div>

			<fieldset
				v-if="status"
				class="flex flex-col gap-2"
				:disabled="saving"
			>
				<legend class="text-sm font-medium">How Much Strata May Use</legend>
				<label
					v-for="allocation in STRATA_ALLOCATIONS"
					:key="allocation"
					class="flex items-start gap-2 text-sm"
				>
					<input
						type="radio"
						name="strata-allocation"
						class="mt-1"
						:value="allocation"
						:checked="status.allocation === allocation"
						:disabled="!allocationAllowed(allocation, free)"
						@change="emit('allocate', allocation)"
					/>
					<span>
						<span class="font-medium">{{ STRATA_ALLOCATION_LABELS[allocation] }}</span>
						<span class="block text-muted">
							{{ STRATA_ALLOCATION_TEXT[allocation] }}
							<template v-if="!allocationAllowed(allocation, free)">
								Paid plans only.
							</template>
						</span>
					</span>
				</label>
				<div
					v-if="!status.applied"
					class="flex flex-wrap items-center gap-3"
				>
					<p class="text-sm text-muted">
						The site has not accepted this setting yet. Turn Strata on and make sure the
						site is reachable, then try again.
					</p>
					<UButton
						color="neutral"
						variant="outline"
						size="sm"
						data-test="strata-retry"
						@click="emit('allocate', status.allocation)"
						>Try Again</UButton
					>
				</div>
			</fieldset>
			<div
				v-if="managed === false"
				class="flex flex-col gap-1"
				data-test="strata-store-self"
			>
				<p class="text-sm text-muted">
					Strata stores where you point it. Drupflare's own backups stay the default.
				</p>
				<p
					v-if="storageNote"
					class="text-sm"
					data-test="strata-storage-note"
				>
					<span class="font-medium">{{ storageNote.label }}.</span>
					{{ storageNote.action }}
				</p>
			</div>
			<p
				v-else-if="status?.store === 'ready'"
				class="text-sm"
				data-test="strata-store-ready"
			>
				Backups go to a private bucket in Drupflare's storage.
			</p>
			<div
				v-else-if="status?.store === 'failed'"
				class="flex flex-wrap items-center gap-3"
				data-test="strata-store-failed"
			>
				<p class="text-sm">
					Storage could not be set up. Strata is on but not saving history.
					{{ storeReason }}
				</p>
				<UButton
					color="neutral"
					variant="outline"
					size="sm"
					data-test="strata-store-retry"
					:disabled="saving"
					@click="emit('retryStore')"
					>Try Again</UButton
				>
			</div>
			<p
				v-if="error"
				role="alert"
				class="text-sm text-error"
			>
				{{ error }}
			</p>
		</template>
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
