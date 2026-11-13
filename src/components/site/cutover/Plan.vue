<script setup lang="ts">
import { POLICY_COPY, type CutoverPolicyName } from '~/shared/cutover-copy';
import { cutoverHandSteps } from '~/shared/operation-copy';
import type { CutoverPayload } from '~/stores/cutover';

const props = defineProps<{ plan: CutoverPayload; busy: boolean; error: string | null }>();
const emit = defineEmits<{
	start: [body: { policy: CutoverPolicyName; source: { ref: string }; hostname: string }];
}>();

const policy = ref<CutoverPolicyName>('freeze');
const sourceRef = ref('');
const hostname = ref('');

const items = computed(() =>
	props.plan.policies.map((entry) => ({
		value: entry.policy,
		label: POLICY_COPY[entry.policy].label,
		description: POLICY_COPY[entry.policy].consequence
	}))
);
const seconds = computed(
	() =>
		props.plan.policies.find((entry) => entry.policy === policy.value)?.expectedWindowSeconds ??
		null
);
const handSteps = computed(() =>
	cutoverHandSteps(hostname.value.trim() || 'your address', props.plan.ttlSeconds, policy.value)
);
const complete = computed(() => sourceRef.value.trim() !== '' && hostname.value.trim() !== '');

function submit(): void {
	if (!complete.value) return;
	emit('start', {
		policy: policy.value,
		source: { ref: sourceRef.value.trim() },
		hostname: hostname.value.trim().toLowerCase()
	});
}
</script>

<template>
	<form
		class="flex flex-col gap-4"
		@submit.prevent="submit()"
	>
		<URadioGroup
			v-model="policy"
			legend="What Happens to Your Old Site"
			:items="items"
		/>
		<SiteCutoverWindow
			:policy="policy"
			:seconds="seconds"
		/>
		<UFormField
			label="Old Site Reference"
			description="The key you made for the old server, then the folder of the site, such as imc_abc.../var/www/html."
		>
			<UInput
				v-model="sourceRef"
				name="source"
				class="w-full"
			/>
		</UFormField>
		<UFormField
			label="Address"
			description="The address that will point at the new site, such as www.example.edu."
		>
			<UInput
				v-model="hostname"
				name="hostname"
				class="w-full"
			/>
		</UFormField>
		<div class="flex flex-col gap-2 rounded-lg border border-default p-4">
			<h2 class="text-sm font-semibold text-highlighted">What You Do by Hand</h2>
			<p class="text-sm text-default">
				Your address lives in your own DNS, so Drupflare cannot change it for you.
			</p>
			<ul class="flex flex-col gap-2 text-sm text-default">
				<li
					v-for="step in handSteps"
					:key="step.id"
				>
					<span class="font-medium text-highlighted">{{ step.when }}.</span>
					{{ step.text }}
				</li>
			</ul>
		</div>
		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>
		<div>
			<UButton
				type="submit"
				:loading="busy"
				:disabled="busy || !complete"
				>Start the Move</UButton
			>
		</div>
	</form>
</template>
