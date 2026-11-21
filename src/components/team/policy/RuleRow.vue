<script setup lang="ts">
import { POLICY_RULE_INFO, type PolicyRuleId } from '~/shared/policies';

const props = defineProps<{ rule: PolicyRuleId }>();
const info = computed(() => POLICY_RULE_INFO[props.rule]);
</script>

<template>
	<fieldset class="flex flex-col gap-2 rounded-md border border-default p-3">
		<legend class="px-1 text-sm font-medium text-highlighted">{{ info.label }}</legend>
		<p class="text-sm text-muted">{{ info.text }}</p>
		<p
			v-if="info.notEnforced"
			class="text-sm text-default"
		>
			<span class="font-medium">Saved, not enforced yet.</span> {{ info.notEnforced }}
		</p>
		<slot />
	</fieldset>
</template>
