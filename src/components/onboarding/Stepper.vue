<script setup lang="ts">
import { STEP_TITLES, type OnboardingStep } from '~/composables/useOnboarding';

defineProps<{ step: OnboardingStep }>();

const steps: readonly OnboardingStep[] = [1, 2];
</script>

<template>
	<div class="flex flex-col gap-2">
		<ol class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
			<li
				v-for="n in steps"
				:key="n"
				class="inline-flex items-center gap-1.5 border-b-2 border-transparent pb-1"
				:aria-current="n === step ? 'step' : undefined"
				:class="
					n === step
						? 'border-brand-600 font-semibold text-highlighted dark:border-brand-400'
						: n < step
							? 'text-leaf-700 dark:text-leaf-300'
							: 'text-muted'
				"
			>
				<UIcon
					:name="n < step ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ n }}. {{ STEP_TITLES[n] }}</span>
			</li>
		</ol>
		<p
			role="status"
			class="sr-only"
		>
			Step {{ step }} of 2: {{ STEP_TITLES[step] }}
		</p>
	</div>
</template>
