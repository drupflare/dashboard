<script setup lang="ts">
import { formatBytes } from '~/shared/utils/format';
import type { ImportDossier } from '~/stores/imports';

const props = defineProps<{ dossier: ImportDossier }>();
const emit = defineEmits<{ next: [] }>();

const VERDICT: Record<ImportDossier['verdict'], { label: string; icon: string }> = {
	ready: { label: 'Ready to Import', icon: 'i-lucide-circle-check' },
	'needs upgrade': { label: 'Needs an Upgrade', icon: 'i-lucide-triangle-alert' },
	refused: { label: 'Cannot Be Imported Yet', icon: 'i-lucide-circle-x' }
};

const verdict = computed(() => VERDICT[props.dossier.verdict] ?? VERDICT.refused);

const filesText = computed(() => {
	const count = props.dossier.estimate.fileCount;
	if (count === 0) return 'No files to copy.';
	return `${count} ${count === 1 ? 'file' : 'files'} to copy.`;
});
</script>

<template>
	<div class="flex flex-col gap-6">
		<p
			role="status"
			class="inline-flex w-fit items-center gap-2 rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-highlighted"
		>
			<UIcon
				:name="verdict.icon"
				class="size-4 shrink-0"
				aria-hidden="true"
			/>
			{{ verdict.label }}
		</p>

		<p class="text-sm text-default">
			Estimated size: {{ formatBytes(dossier.estimate.bytes) }}. {{ filesText }}
		</p>

		<section
			v-if="dossier.refusals.length > 0"
			class="flex flex-col gap-3"
		>
			<h3 class="text-base font-semibold text-highlighted">What to Change</h3>
			<ul class="flex list-disc flex-col gap-2 pl-5 text-sm text-default">
				<li
					v-for="refusal in dossier.refusals"
					:key="refusal"
				>
					{{ refusal }}
				</li>
			</ul>
		</section>

		<section class="flex flex-col gap-3">
			<h3 class="text-base font-semibold text-highlighted">Findings</h3>
			<p
				v-if="dossier.findings.length === 0"
				class="text-sm text-muted"
			>
				The check found nothing to report.
			</p>
			<ul
				v-else
				class="flex flex-col"
			>
				<OnboardingImportDossierFinding
					v-for="(finding, index) in dossier.findings"
					:key="`${index}-${finding.title}`"
					:finding="finding"
				/>
			</ul>
		</section>

		<div v-if="dossier.importable">
			<UButton
				color="primary"
				variant="solid"
				@click="emit('next')"
			>
				Next
			</UButton>
		</div>
	</div>
</template>
