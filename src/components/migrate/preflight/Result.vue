<script setup lang="ts">
import {
	CMS_LABELS,
	SIGNAL_LABELS,
	SURVEY_ONLY_NOTE,
	VERDICT_LABELS,
	type PreflightResult,
	type Verdict
} from '~/shared/preflight';

const props = defineProps<{ result: PreflightResult }>();

const ICONS: Record<Verdict, string> = {
	candidate: 'i-lucide-scan-search',
	'needs upgrade': 'i-lucide-circle-arrow-up',
	'not yet supported': 'i-lucide-clock',
	'cannot tell': 'i-lucide-circle-help'
};

const heading = ref<HTMLElement | null>(null);
const title = computed(() =>
	props.result.reachable ? VERDICT_LABELS[props.result.verdict] : 'Could Not Read This Address'
);

defineExpose({ focus: () => heading.value?.focus() });
</script>

<template>
	<section
		aria-labelledby="preflight-verdict"
		class="flex flex-col gap-5 rounded-lg border border-default p-5 sm:p-6"
	>
		<div class="flex flex-col gap-1">
			<h2
				id="preflight-verdict"
				ref="heading"
				tabindex="-1"
				class="flex items-center gap-2 text-xl font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
			>
				<UIcon
					:name="result.reachable ? ICONS[result.verdict] : 'i-lucide-circle-alert'"
					class="size-6 shrink-0"
					aria-hidden="true"
				/>
				{{ title }}
			</h2>
			<p class="break-all text-sm text-muted">
				Address read: <span class="font-mono">{{ result.url }}</span>
			</p>
		</div>

		<p
			v-for="note in result.notes"
			:key="note"
			class="max-w-prose text-default"
		>
			{{ note }}
		</p>

		<template v-if="result.reachable">
			<dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
				<dt class="font-semibold text-highlighted">System</dt>
				<dd class="text-default">{{ CMS_LABELS[result.cms] }}</dd>
				<dt class="font-semibold text-highlighted">Version</dt>
				<dd class="text-default">
					<template v-if="result.version">
						{{ result.version }}, printed by {{ result.versionSource }}
					</template>
					<template v-else>Not printed on any page the check read</template>
				</dd>
				<dt class="font-semibold text-highlighted">Hosting</dt>
				<dd class="text-default">{{ result.hosting ?? 'Not visible from outside' }}</dd>
			</dl>

			<div class="flex flex-col gap-2">
				<h3 class="text-base font-semibold text-highlighted">What the Check Saw</h3>
				<ul
					v-if="result.signals.length > 0"
					class="flex flex-col divide-y divide-default text-sm"
				>
					<li
						v-for="(signal, index) in result.signals"
						:key="index"
						class="grid gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-4"
					>
						<span class="font-medium text-highlighted">{{
							SIGNAL_LABELS[signal.kind]
						}}</span>
						<span class="break-words text-default">{{ signal.detail }}</span>
					</li>
				</ul>
				<p
					v-else
					class="text-sm text-muted"
				>
					The site showed nothing the check could read.
				</p>
			</div>

			<p class="max-w-prose text-sm text-muted">{{ SURVEY_ONLY_NOTE }}</p>

			<div class="flex flex-wrap items-center gap-3">
				<UButton :to="{ path: '/login', query: { redirect: '/new/import' } }">
					Create an Account to Connect Your Server
				</UButton>
				<UButton
					to="/migrate"
					color="neutral"
					variant="ghost"
					>What Moves and What Does Not</UButton
				>
			</div>
		</template>
	</section>
</template>
