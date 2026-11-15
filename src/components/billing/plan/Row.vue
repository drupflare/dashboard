<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import { formatCount, formatDollars } from '~/shared/utils/format';
import type { BillingPlan } from '~/stores/billing';

const props = defineProps<{
	plan: BillingPlan;
	current: boolean;
	interval: Interval;
	// the viewer may buy and the organization has no subscription to change instead
	canSubscribe: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{ subscribe: [] }>();

const CONTACT = 'mailto:support@drupflare.com';

const value = computed(() => (props.interval === 'month' ? props.plan.monthly : props.plan.annual));
const amount = computed(() => (typeof value.value === 'number' ? value.value : null));
const byContract = computed(() => ['institution', 'enterprise'].includes(props.plan.kind));
const selfServe = computed(() => ['managed', 'self-managed'].includes(props.plan.kind));
const sellable = computed(
	() => selfServe.value && !props.plan.disabled && amount.value !== null && amount.value > 0
);

const saving = computed(() => {
	const { monthly, annual } = props.plan;
	if (props.interval !== 'year' || typeof monthly !== 'number' || typeof annual !== 'number') {
		return null;
	}
	const saved = monthly * 12 - annual;
	return saved > 0 ? formatDollars(saved) : null;
});

const price = computed(() => {
	if (amount.value === null) return null;
	return amount.value === 0 ? 'Free' : `${formatDollars(amount.value)} a ${props.interval}`;
});

const sites = computed(() => {
	const { plan } = props;
	if (plan.sitesUnlimited) return 'Unlimited sites';
	if (plan.sites === null) return 'Sites by contract';
	return `${plan.sites} ${plan.sites === 1 ? 'site' : 'sites'}`;
});

const views = computed(() => {
	const { plan } = props;
	if (plan.views !== null) return `${formatCount(plan.views)} views a month`;
	if (plan.plane === 'self-managed') return 'Traffic on your Cloudflare plan';
	if (plan.plane === 'self-hosted') return 'Traffic on your own server';
	return 'Views by contract';
});

const busyKey = computed(() => `${props.plan.id}:${props.interval}`);
</script>

<template>
	<li
		class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
		:class="plan.disabled && 'opacity-60'"
	>
		<div class="flex min-w-0 flex-col gap-1">
			<div class="flex flex-wrap items-center gap-2">
				<h4 class="font-medium text-highlighted">{{ plan.name }}</h4>
				<UBadge
					v-if="current"
					color="primary"
					variant="subtle"
					size="sm"
					>Current Plan</UBadge
				>
				<UBadge
					v-if="plan.unreviewed"
					color="warning"
					variant="subtle"
					size="sm"
					>Unreviewed Price</UBadge
				>
				<UBadge
					v-if="plan.disabled"
					color="neutral"
					variant="subtle"
					size="sm"
					>Coming Soon</UBadge
				>
			</div>
			<p class="text-sm text-muted">{{ sites }}, {{ views }}, {{ plan.support }} support</p>
		</div>

		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
			<div class="flex flex-col sm:items-end">
				<p
					v-if="price"
					class="tabular-nums text-highlighted"
				>
					{{ price }}
				</p>
				<p
					v-else-if="byContract"
					class="text-sm text-muted"
				>
					Pricing on request
				</p>
				<p
					v-else
					class="text-sm text-muted"
				>
					Pricing is not published yet.
				</p>
				<p
					v-if="saving"
					class="text-xs text-muted"
				>
					Saves {{ saving }} a year
				</p>
			</div>

			<UButton
				v-if="byContract && !current"
				color="neutral"
				variant="outline"
				:to="CONTACT"
				:aria-label="`Contact Us About ${plan.name}`"
			>
				Contact Us
			</UButton>
			<UButton
				v-else-if="sellable && !current && canSubscribe"
				:loading="busy === busyKey"
				:disabled="busy !== null"
				:aria-label="`Subscribe to ${plan.name}`"
				@click="emit('subscribe')"
			>
				Subscribe
			</UButton>
		</div>
	</li>
</template>
