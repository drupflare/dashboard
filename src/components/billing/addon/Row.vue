<script setup lang="ts">
import type { Interval } from '~/shared/plans';
import { formatDollars } from '~/shared/utils/format';
import type { BillingAddOn } from '~/stores/billing';

const props = defineProps<{
	addOn: BillingAddOn;
	// the quantity the organization holds; 0 when none
	held: number;
	interval: Interval;
	canBuy: boolean;
	busy: string | null;
}>();

const emit = defineEmits<{
	subscribe: [quantity: number];
	change: [quantity: number];
	pack: [units: number];
}>();

const MAX_QUANTITY = 100;

const quantity = ref<number | undefined>(props.held > 0 ? props.held : 1);
const packItems = computed(() =>
	(props.addOn.packs ?? [])
		.filter((pack) => typeof pack.price === 'number' && pack.price > 0)
		.map((pack) => ({
			label: `${pack.units} ${pack.units === 1 ? 'unit' : 'units'}, ${formatDollars(pack.price as number)}`,
			value: pack.units
		}))
);
const units = ref<number>(packItems.value[0]?.value ?? 0);

watch(
	() => props.held,
	(held) => {
		quantity.value = held > 0 ? held : 1;
	}
);

// a support level or a flag is held once, so it has no quantity
const single = computed(() => ['support-level', 'assurance'].includes(props.addOn.meter));

const unitPrice = computed(() => {
	const value = props.interval === 'month' ? props.addOn.monthly : props.addOn.annual;
	return typeof value === 'number' && value > 0 ? value : null;
});
const subscribable = computed(() => props.addOn.subscription && unitPrice.value !== null);
const buyable = computed(() => subscribable.value || packItems.value.length > 0);

const valid = computed(
	() =>
		Number.isInteger(quantity.value) &&
		(quantity.value as number) >= (props.held > 0 ? 0 : 1) &&
		(quantity.value as number) <= MAX_QUANTITY
);
const changed = computed(() => quantity.value !== props.held);
const total = computed(() =>
	unitPrice.value !== null && valid.value && (quantity.value as number) > 1
		? `Total ${formatDollars(unitPrice.value * (quantity.value as number))} a ${props.interval}`
		: null
);

const priceLine = computed(() =>
	unitPrice.value === null
		? null
		: `${formatDollars(unitPrice.value)} a ${props.interval}${single.value ? '' : ' each'}`
);

const action = computed(() => {
	if (single.value) return props.held > 0 ? 'Remove' : 'Add';
	if (props.held === 0) return 'Add';
	return quantity.value === 0 ? 'Remove' : 'Update';
});

const key = (kind: string) => `addon:${props.addOn.id}:${kind}`;

function submit(): void {
	if (!valid.value) return;
	const count = single.value ? (props.held > 0 ? 0 : 1) : (quantity.value as number);
	if (props.held === 0) emit('subscribe', count);
	else emit('change', count);
}
</script>

<template>
	<li class="flex flex-col gap-3 py-4">
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
			<div class="flex min-w-0 flex-col gap-1">
				<div class="flex flex-wrap items-center gap-2">
					<h4 class="font-medium text-highlighted">{{ addOn.name }}</h4>
					<UBadge
						v-if="held > 0"
						color="primary"
						variant="subtle"
						size="sm"
						>{{ single ? 'Added' : `You Have ${held}` }}</UBadge
					>
					<UBadge
						v-if="addOn.unreviewed"
						color="warning"
						variant="subtle"
						size="sm"
						>Unreviewed Price</UBadge
					>
				</div>
				<p class="text-sm text-muted">
					{{ single ? addOn.unit : `Each unit is ${addOn.unit}.` }}
				</p>
			</div>
			<div
				v-if="priceLine"
				class="flex flex-col sm:items-end"
			>
				<p class="tabular-nums text-highlighted">{{ priceLine }}</p>
				<p
					v-if="total"
					class="text-xs tabular-nums text-muted"
				>
					{{ total }}
				</p>
			</div>
		</div>

		<p
			v-if="!addOn.available"
			class="max-w-prose text-sm text-muted"
		>
			Not available yet. {{ addOn.availableNote }}
		</p>
		<p
			v-else-if="!buyable"
			class="text-sm text-muted"
		>
			Pricing is not published yet.
		</p>

		<div
			v-if="addOn.available && canBuy && buyable"
			class="flex flex-wrap items-end gap-x-8 gap-y-3"
		>
			<div
				v-if="subscribable || held > 0"
				class="flex flex-col gap-1"
			>
				<span class="text-xs text-muted">
					{{ interval === 'month' ? 'Monthly Subscription' : 'Annual Subscription' }}
				</span>
				<div class="flex items-center gap-2">
					<UInputNumber
						v-if="!single"
						v-model="quantity"
						:min="held > 0 ? 0 : 1"
						:max="MAX_QUANTITY"
						:disabled="busy !== null"
						:aria-label="`Quantity of ${addOn.name}`"
						class="w-32"
					/>
					<UButton
						:color="action === 'Remove' ? 'neutral' : 'primary'"
						:variant="action === 'Remove' ? 'outline' : 'solid'"
						:loading="busy === key('sub') || busy === key('set')"
						:disabled="busy !== null || !valid || (!single && !changed)"
						:aria-label="`${action} ${addOn.name}`"
						@click="submit()"
					>
						{{ action }}
					</UButton>
				</div>
			</div>

			<div
				v-if="packItems.length > 0"
				class="flex flex-col gap-1"
			>
				<span class="text-xs text-muted">One-Time Pack</span>
				<div class="flex items-center gap-2">
					<USelect
						v-if="packItems.length > 1"
						v-model="units"
						:items="packItems"
						:disabled="busy !== null"
						:aria-label="`Pack size for ${addOn.name}`"
						class="w-44"
					/>
					<span
						v-else
						class="text-sm tabular-nums text-highlighted"
						>{{ packItems[0]?.label }}</span
					>
					<UButton
						color="neutral"
						variant="outline"
						:loading="busy === key('pack')"
						:disabled="busy !== null"
						:aria-label="`Buy a Pack of ${addOn.name}`"
						@click="emit('pack', units)"
					>
						Buy Pack
					</UButton>
				</div>
			</div>
		</div>
	</li>
</template>
