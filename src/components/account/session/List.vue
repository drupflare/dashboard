<script setup lang="ts">
import type { Device } from '~/stores/devices';

const props = defineProps<{ items: Device[]; busy: string | null }>();
const emit = defineEmits<{ revoke: [id: string] }>();
</script>

<template>
	<ul class="flex flex-col divide-y divide-default rounded-lg border border-default">
		<AccountSessionRow
			v-for="device in props.items"
			:key="device.id"
			:device="device"
			:busy="props.busy === `device:${device.id}`"
			@revoke="emit('revoke', device.id)"
		/>
	</ul>
</template>
