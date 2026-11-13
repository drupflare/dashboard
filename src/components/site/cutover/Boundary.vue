<script setup lang="ts">
import {
	CHOICE_COPY,
	ROLLBACK_LABEL,
	finalChangesSentence,
	writesSentence,
	type CutoverChoiceName
} from '~/shared/cutover-copy';
import { ROLLBACK_BOUNDARY_COPY, stepLabel } from '~/shared/operation-copy';
import type { CutoverView } from '~/stores/cutover';

const props = defineProps<{ view: CutoverView; busy: boolean; downloadUrl?: string }>();
const emit = defineEmits<{ choose: [value: CutoverChoiceName | 'rollback'] }>();

const phrase = (id: string) => {
	const text = stepLabel('migration.cutover', id);
	return text.charAt(0).toUpperCase() + text.slice(1);
};
const choices = Object.keys(CHOICE_COPY) as CutoverChoiceName[];
const MARK = 'route';
const canGoBack = computed(
	() => props.view.state === 'observing' && props.view.boundary === 'dns-reversal'
);
const mustChoose = computed(
	() =>
		props.view.state === 'observing' &&
		props.view.boundary === 'post-write' &&
		props.view.choice === null
);
const sentence = computed(() => writesSentence(props.view.destinationWrites, props.view.observed));
const stateOf = (state: string) =>
	({
		pending: 'Waiting',
		running: 'Running',
		succeeded: 'Done',
		failed: 'Failed',
		skipped: 'Skipped'
	})[state] ?? state;
</script>

<template>
	<div class="flex flex-col gap-4">
		<ol
			class="flex flex-col divide-y divide-default rounded-lg border border-default"
			aria-label="Move Timeline"
		>
			<template
				v-for="step in view.steps"
				:key="step.id"
			>
				<li
					class="flex items-center justify-between gap-3 px-4 py-2 text-sm"
					:data-state="step.state"
				>
					<span class="text-default">{{ phrase(step.id) }}</span>
					<span class="text-muted">{{ stateOf(step.state) }}</span>
				</li>
				<li
					v-if="step.id === MARK"
					role="separator"
					data-test="boundary"
					:data-boundary="view.boundary"
					class="bg-elevated px-4 py-2 text-sm font-medium text-highlighted"
				>
					{{ ROLLBACK_BOUNDARY_COPY[view.boundary] }}
				</li>
			</template>
		</ol>

		<p
			v-if="sentence"
			class="text-sm text-default"
			data-test="writes"
		>
			{{ sentence }}
		</p>

		<p
			v-if="view.refusal"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ view.refusal.message }}
		</p>

		<div
			v-if="canGoBack"
			class="flex flex-col gap-2"
		>
			<UButton
				color="neutral"
				variant="outline"
				:disabled="busy"
				@click="emit('choose', 'rollback')"
				>{{ ROLLBACK_LABEL }}</UButton
			>
		</div>

		<div
			v-if="mustChoose"
			class="flex flex-col gap-3"
			data-test="choices"
		>
			<div
				v-for="value in choices"
				:key="value"
				class="flex flex-col gap-1 rounded-lg border border-default p-3 text-sm"
			>
				<p class="text-default">{{ CHOICE_COPY[value].consequence }}</p>
				<div>
					<UButton
						color="neutral"
						variant="outline"
						:disabled="busy"
						@click="emit('choose', value)"
						>{{ CHOICE_COPY[value].label }}</UButton
					>
				</div>
			</div>
		</div>

		<p
			v-if="view.choice"
			class="text-sm text-default"
		>
			You chose: {{ CHOICE_COPY[view.choice.value].label }}.
		</p>

		<div
			v-if="view.exportReference"
			class="flex flex-col gap-1 text-sm text-default"
			data-test="export"
		>
			<p>
				Your new changes were saved as a SQL file. Run it against the database of your old
				site.
			</p>
			<p
				v-if="view.finalChanges"
				data-test="final-changes"
			>
				{{ finalChangesSentence(view.finalChanges, view.finalStatements) }}
			</p>
			<div v-if="downloadUrl">
				<UButton
					color="neutral"
					variant="outline"
					:href="downloadUrl"
					download
					>Download the Changes</UButton
				>
			</div>
			<template v-if="view.cannotCarry.length > 0">
				<p>The file does not carry these:</p>
				<ul class="list-disc pl-5">
					<li
						v-for="kind in view.cannotCarry"
						:key="kind"
					>
						{{ kind }}
					</li>
				</ul>
			</template>
		</div>
	</div>
</template>
