<script setup lang="ts">
import { explainFinding } from '~/shared/custom-findings';
import type { Finding } from '~/shared/recipes';

const props = defineProps<{ findings: Finding[]; deployable: boolean }>();

const blocking = computed(() =>
	props.findings.filter((finding) => finding.severity === 'blocking')
);
const others = computed(() => props.findings.filter((finding) => finding.severity !== 'blocking'));
</script>

<template>
	<section
		class="flex flex-col gap-4"
		aria-labelledby="custom-findings"
	>
		<h3
			id="custom-findings"
			class="text-base font-semibold text-highlighted"
		>
			What We Found
		</h3>
		<p
			class="text-sm text-default"
			role="status"
		>
			<template v-if="deployable">This bundle can be deployed.</template>
			<template v-else>
				This bundle cannot be deployed yet. Fix the items below, build again and upload it
				again.
			</template>
		</p>

		<ul
			v-if="blocking.length > 0"
			class="flex flex-col gap-3"
			aria-label="Items to fix"
		>
			<li
				v-for="(finding, index) in blocking"
				:key="`${finding.code}-${index}`"
				class="flex flex-col gap-1 rounded-md border border-default p-3"
			>
				<p
					class="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-400"
				>
					<UIcon
						name="i-lucide-circle-x"
						class="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{{ explainFinding(finding).title }}</span>
				</p>
				<p class="text-sm text-muted">In {{ finding.subject }}</p>
				<p
					v-if="explainFinding(finding).change"
					class="text-sm text-default"
				>
					{{ explainFinding(finding).change }}
				</p>
			</li>
		</ul>

		<ul
			v-if="others.length > 0"
			class="flex flex-col gap-2"
			aria-label="Things to know"
		>
			<li
				v-for="(finding, index) in others"
				:key="`${finding.code}-${index}`"
				class="flex items-start gap-2 text-sm text-muted"
			>
				<UIcon
					:name="
						finding.severity === 'warning' ? 'i-lucide-circle-alert' : 'i-lucide-info'
					"
					class="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ explainFinding(finding).title }}</span>
			</li>
		</ul>
	</section>
</template>
