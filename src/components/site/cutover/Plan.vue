<script setup lang="ts">
import { POLICY_COPY, type CutoverPolicyName } from '~/shared/cutover-copy';
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
			description="The reference of the site you are moving from."
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
