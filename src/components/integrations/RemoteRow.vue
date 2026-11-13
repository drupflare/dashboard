<script setup lang="ts">
import type { RemoteView } from '~/shared/repo-connections';

const props = defineProps<{ remote: RemoteView }>();

const status = computed(() => {
	switch (props.remote.lastPullStatus) {
		case 'installed':
			return { label: 'Pulled', color: 'success', icon: 'i-lucide-circle-check' } as const;
		case 'failed':
			return { label: 'Pull Failed', color: 'error', icon: 'i-lucide-circle-alert' } as const;
		default:
			return { label: 'Not Pulled Yet', color: 'neutral', icon: 'i-lucide-clock' } as const;
	}
});

const lastPull = computed(() =>
	props.remote.lastPullAt === null
		? 'Never'
		: new Date(props.remote.lastPullAt).toLocaleString(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short'
			})
);
</script>

<template>
	<li class="flex flex-col gap-3 rounded-lg border border-default p-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h3 class="wrap-break-word font-medium text-highlighted">{{ remote.repo }}</h3>
				<p class="text-sm text-muted">Branch {{ remote.branch }}</p>
			</div>
			<UBadge
				:color="status.color"
				variant="subtle"
				:icon="status.icon"
				>{{ status.label }}</UBadge
			>
		</div>
		<dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
			<div class="flex gap-2">
				<dt class="text-muted">Mount Path</dt>
				<dd class="break-all text-default">{{ remote.mountPath }}</dd>
			</div>
			<div class="flex gap-2">
				<dt class="text-muted">Pull Every</dt>
				<dd class="text-default">{{ remote.intervalMinutes }} minutes</dd>
			</div>
			<div class="flex gap-2">
				<dt class="text-muted">Last Pull</dt>
				<dd class="text-default">{{ lastPull }}</dd>
			</div>
		</dl>
	</li>
</template>
