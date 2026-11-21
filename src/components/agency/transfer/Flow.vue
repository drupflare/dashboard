<script setup lang="ts">
import type { TransferView } from '~/shared/agency';

const props = defineProps<{
	transfer: TransferView;
	side: 'outgoing' | 'incoming';
	canAnswer: boolean;
	canCancel: boolean;
	canComplete: boolean;
}>();
const emit = defineEmits<{
	accept: [];
	decline: [];
	cancel: [];
	complete: [];
}>();

const STATE_TEXT: Record<TransferView['state'], string> = {
	proposed: 'Waiting for the receiving organization to answer.',
	accepted: 'Accepted. Complete the move to hand the site over.',
	completing: 'The handover is running. This page updates when it ends.',
	failed: 'The handover stopped before it finished.',
	declined: 'Declined. The site stays with the sending organization.',
	cancelled: 'Cancelled by the sending organization.',
	completed: 'Completed. The site now belongs to the receiving organization.',
	expired: 'Expired before an answer. Propose the transfer again.'
};

const STATE_LABEL: Record<TransferView['state'], string> = {
	proposed: 'Waiting for Answer',
	accepted: 'Accepted',
	completing: 'Handover Running',
	failed: 'Handover Failed',
	declined: 'Declined',
	cancelled: 'Cancelled',
	completed: 'Completed',
	expired: 'Expired'
};

const open = computed(() => props.transfer.state === 'proposed');
const accepted = computed(() => ['accepted', 'failed'].includes(props.transfer.state));
</script>

<template>
	<article
		class="flex flex-col gap-3 rounded-lg border border-default bg-default p-4"
		:aria-labelledby="`transfer-${transfer.id}`"
	>
		<header class="flex flex-wrap items-center justify-between gap-2">
			<h3
				:id="`transfer-${transfer.id}`"
				class="text-base font-semibold text-highlighted"
			>
				Site {{ transfer.siteId }}
			</h3>
			<UBadge
				color="neutral"
				variant="subtle"
				>{{ STATE_LABEL[transfer.state] }}</UBadge
			>
		</header>
		<p class="text-sm text-default">{{ STATE_TEXT[transfer.state] }}</p>
		<p
			v-if="transfer.failureReason"
			class="text-sm text-muted"
		>
			{{ transfer.failureReason }}
		</p>
		<p class="text-sm text-muted">
			<template v-if="side === 'outgoing'"
				>To organization {{ transfer.toOrganizationId }}.</template
			>
			<template v-else>From organization {{ transfer.fromOrganizationId }}.</template>
			<template v-if="open"
				>Answer by {{ new Date(transfer.expiresAt).toLocaleDateString() }}.</template
			>
		</p>
		<div
			v-if="(open && (canAnswer || canCancel)) || (accepted && canComplete)"
			class="flex flex-wrap gap-2"
		>
			<template v-if="open && side === 'incoming' && canAnswer">
				<UButton @click="emit('accept')">Accept Transfer</UButton>
				<UButton
					color="neutral"
					variant="outline"
					@click="emit('decline')"
					>Decline Transfer</UButton
				>
			</template>
			<UButton
				v-if="open && side === 'outgoing' && canCancel"
				color="neutral"
				variant="outline"
				@click="emit('cancel')"
				>Cancel Transfer</UButton
			>
			<UButton
				v-if="accepted && side === 'incoming' && canComplete"
				@click="emit('complete')"
				>{{ transfer.state === 'failed' ? 'Try Again' : 'Complete Transfer' }}</UButton
			>
		</div>
	</article>
</template>
