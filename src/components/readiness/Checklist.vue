<script setup lang="ts">
import { useHealthStore } from '~/stores/health';

const props = defineProps<{ orgId: string; siteId: string }>();

const store = useHealthStore();
const readiness = computed(() => store.bySite.get(props.siteId)?.readiness);

// one read when nothing has loaded; the health tree owns the polling
onMounted(() => void store.load(props.orgId, props.siteId));

const LEVEL = {
	pending: 'Not Live Yet',
	live: 'Live',
	verified: 'Verified',
	'production-ready': 'Production Ready'
} as const;

const TIERS = [
	{ id: 'live', title: 'Live' },
	{ id: 'verified', title: 'Verified' },
	{ id: 'production-ready', title: 'Production Ready' }
] as const;

const STATE = {
	done: {
		label: 'Done',
		icon: 'i-lucide-circle-check',
		tone: 'text-leaf-700 dark:text-leaf-300'
	},
	open: {
		label: 'Not Done',
		icon: 'i-lucide-circle-dashed',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	'not-checked': { label: 'Not Checked', icon: 'i-lucide-circle-help', tone: 'text-muted' }
} as const;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const summary = computed(() => {
	const value = readiness.value;
	if (!value) return '';
	const next = value.missing[0];
	return next === undefined ? LEVEL[value.level] : `${LEVEL[value.level]}. Next: ${next}`;
});
</script>

<template>
	<section
		class="flex flex-col gap-4"
		aria-labelledby="site-readiness-title"
	>
		<h2
			id="site-readiness-title"
			class="text-lg font-semibold text-highlighted"
		>
			Readiness
		</h2>

		<p
			v-if="!readiness"
			class="text-sm text-muted"
			role="status"
		>
			Checking readiness
		</p>

		<template v-else>
			<p
				class="font-medium text-highlighted"
				data-test="readiness-summary"
			>
				{{ summary }}
			</p>
			<section
				v-for="tier in TIERS"
				:key="tier.id"
				class="flex flex-col gap-1"
			>
				<h3 class="text-sm font-semibold text-highlighted">{{ tier.title }}</h3>
				<ul
					class="flex flex-col divide-y divide-default rounded-lg border border-default px-4"
				>
					<li
						v-for="check in readiness.checks.filter((c) => c.tier === tier.id)"
						:key="check.label"
						class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
					>
						<span>{{ sentence(check.label) }}</span>
						<span
							class="inline-flex items-center gap-1.5"
							:class="STATE[check.state].tone"
							data-test="check-state"
						>
							<UIcon
								:name="STATE[check.state].icon"
								class="size-4 shrink-0"
								aria-hidden="true"
							/>
							<span>{{ STATE[check.state].label }}</span>
						</span>
					</li>
				</ul>
			</section>
		</template>
	</section>
</template>
