<script setup lang="ts">
import { dollars, formatPercent, type CreditsView } from '~/shared/capacity';

const props = defineProps<{ view: CreditsView }>();

const day = (iso: string | null) => (iso === null ? 'Unknown' : iso.slice(0, 10));

const used = computed(() => {
	const view = props.view;
	if (view.state !== 'ok' || view.originalCents <= 0) return 0;
	return (view.usedCents * 100) / view.originalCents;
});

const notice = computed(() => {
	switch (props.view.state) {
		case 'none':
			return 'This account has no credit grant on record.';
		case 'no_billing_access':
			return 'The token has no billing access. Give it the Billing Read permission to see the grant.';
		case 'not_configured':
			return 'The dashboard has no Cloudflare credentials yet, so it cannot read the grant.';
		default:
			return 'The credit grant could not be read. The next refresh tries again.';
	}
});
</script>

<template>
	<section
		class="flex max-w-md flex-col gap-3"
		aria-labelledby="capacity-credits"
	>
		<h2
			id="capacity-credits"
			class="text-lg font-semibold text-highlighted"
		>
			Credit Grant
		</h2>
		<template v-if="view.state === 'ok'">
			<dl class="grid grid-cols-2 gap-y-2">
				<dt class="text-muted">Balance</dt>
				<dd class="text-right font-semibold text-highlighted">
					{{ dollars(view.balanceCents, view.currency) }}
				</dd>
				<dt class="text-muted">Original Amount</dt>
				<dd class="text-right font-medium text-highlighted">
					{{ dollars(view.originalCents, view.currency) }}
				</dd>
				<dt class="text-muted">Used</dt>
				<dd class="text-right font-medium text-highlighted">
					{{ dollars(view.usedCents, view.currency) }} ({{ formatPercent(used) }})
				</dd>
				<dt class="text-muted">Days Remaining</dt>
				<dd class="text-right font-medium text-highlighted">
					{{ view.daysRemaining ?? 'Unknown' }}
				</dd>
				<dt class="text-muted">Expires</dt>
				<dd class="text-right font-medium text-highlighted">{{ day(view.validTo) }}</dd>
				<dt class="text-muted">Projected Depletion</dt>
				<dd class="text-right font-medium text-highlighted">
					{{
						view.projectedDepletion === null
							? 'None projected'
							: day(view.projectedDepletion)
					}}
				</dd>
			</dl>
			<div
				aria-hidden="true"
				class="h-2 w-full overflow-hidden rounded-full bg-elevated"
			>
				<div
					class="h-2 bg-primary"
					:style="{ width: `${Math.min(100, used)}%` }"
				/>
			</div>
		</template>
		<p
			v-else
			class="text-muted"
			role="status"
		>
			{{ notice }}
		</p>
	</section>
</template>
