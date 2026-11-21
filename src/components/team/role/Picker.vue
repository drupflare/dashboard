<script setup lang="ts">
import { ORG_ROLE_LABELS } from '~/shared/members';
import type { OrgRole } from '~/shared/permissions';

const props = defineProps<{
	modelValue: OrgRole;
	roles: readonly OrgRole[];
	label: string;
	disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [role: OrgRole] }>();

const items = computed(() =>
	props.roles.map((role) => ({ label: ORG_ROLE_LABELS[role], value: role }))
);
</script>

<template>
	<USelect
		:model-value="modelValue"
		:items="items"
		:disabled="disabled"
		:aria-label="label"
		class="w-full"
		@update:model-value="emit('update:modelValue', $event as OrgRole)"
	/>
</template>
