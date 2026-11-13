<script setup lang="ts">
import type { NodeView } from '~/shared/nodes';

defineProps<{ orgId: string; node: NodeView }>();

const seenAt = (at: string | null) =>
	at === null
		? 'Never'
		: new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<template>
	<li class="flex flex-col gap-3 rounded-lg border border-default p-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h3 class="wrap-break-word font-medium text-highlighted">{{ node.name }}</h3>
				<p class="text-sm text-muted">{{ node.os }} {{ node.arch }}</p>
			</div>
			<UBadge
				:color="node.state === 'active' ? 'success' : 'neutral'"
				variant="subtle"
				>{{ node.state === 'active' ? 'Active' : 'Revoked' }}</UBadge
			>
		</div>
		<dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
			<div class="flex gap-2">
				<dt class="text-muted">Bastion</dt>
				<dd class="text-default">{{ node.bastionVersion }}</dd>
			</div>
			<div class="flex gap-2">
				<dt class="text-muted">Mode</dt>
				<dd class="text-default">{{ node.mode }}</dd>
			</div>
			<div class="flex gap-2">
				<dt class="text-muted">Last Seen</dt>
				<dd class="text-default">{{ seenAt(node.lastSeenAt) }}</dd>
			</div>
		</dl>
		<div v-if="node.state === 'active'">
			<NodeRevoke
				:org-id="orgId"
				:node="node"
			/>
		</div>
	</li>
</template>
