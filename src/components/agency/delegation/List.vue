<script setup lang="ts">
import type { DelegationView } from '~/shared/agency';

const props = defineProps<{
	items: DelegationView[];
	direction: 'sent' | 'received';
	canAccept: boolean;
	canRevoke: boolean;
}>();
const emit = defineEmits<{ accept: [id: string]; revoke: [id: string] }>();

const ROLE_LABEL: Record<DelegationView['role'], string> = {
	maintainer: 'Maintainer',
	viewer: 'Viewer'
};

const STATE_LABEL: Record<DelegationView['state'], string> = {
	pending: 'Waiting for Acceptance',
	active: 'Active',
	revoked: 'Ended',
	expired: 'Expired'
};

const sitesText = (item: DelegationView) =>
	item.sites === 'all' ? 'All sites' : `${item.sites.length} selected sites`;

const otherOrg = (item: DelegationView) =>
	props.direction === 'sent' ? item.agencyOrganizationId : item.clientOrganizationId;
</script>

<template>
	<ul class="flex flex-col gap-3">
		<li
			v-for="item in items"
			:key="item.id"
			class="flex flex-col gap-2 rounded-lg border border-default bg-default p-4"
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<span class="font-medium text-highlighted">{{ ROLE_LABEL[item.role] }}</span>
				<UBadge
					color="neutral"
					variant="subtle"
					>{{ STATE_LABEL[item.state] }}</UBadge
				>
			</div>
			<p class="text-sm text-muted">
				{{ direction === 'sent' ? 'Agency' : 'Client' }}
				<code class="break-all text-default">{{ otherOrg(item) }}</code>
				· {{ sitesText(item) }}
			</p>
			<p
				v-if="item.expiresAt"
				class="text-sm text-muted"
			>
				Ends {{ new Date(item.expiresAt).toLocaleDateString() }}.
			</p>
			<div class="flex flex-wrap gap-2">
				<UButton
					v-if="direction === 'received' && item.state === 'pending' && canAccept"
					@click="emit('accept', item.id)"
					>Accept Access</UButton
				>
				<UButton
					v-if="(item.state === 'pending' || item.state === 'active') && canRevoke"
					color="neutral"
					variant="outline"
					@click="emit('revoke', item.id)"
					>End Access</UButton
				>
			</div>
		</li>
	</ul>
</template>
