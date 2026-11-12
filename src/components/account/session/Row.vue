<script setup lang="ts">
import type { Device } from '~/stores/devices';

const props = defineProps<{ device: Device; busy?: boolean }>();
const emit = defineEmits<{ revoke: [] }>();

const when = (value: string) =>
	new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<template>
	<li class="flex flex-wrap items-center justify-between gap-3 p-4">
		<div class="flex flex-col gap-1">
			<span class="flex flex-wrap items-center gap-2 font-medium text-highlighted">
				{{ props.device.device }}
				<span
					v-if="props.device.current"
					class="rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-muted"
				>
					This Device
				</span>
			</span>
			<span class="text-sm text-muted">
				Last used {{ when(props.device.lastSeenAt) }}
				<template v-if="props.device.ip">from {{ props.device.ip }}</template>
			</span>
			<span class="text-sm text-muted">Signed in {{ when(props.device.createdAt) }}</span>
		</div>
		<UButton
			v-if="!props.device.current"
			size="sm"
			color="neutral"
			variant="outline"
			:loading="props.busy"
			@click="emit('revoke')"
		>
			Sign Out
		</UButton>
	</li>
</template>
