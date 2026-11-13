<script setup lang="ts">
import type { ConnectionView } from '~/shared/repo-connections';
import { PROVIDER_LABELS } from '~/stores/repo-connections';

const props = defineProps<{ connection: ConnectionView; canRevoke: boolean; busy: boolean }>();
const emit = defineEmits<{ revoke: [] }>();

const open = ref(false);
const label = computed(() => PROVIDER_LABELS[props.connection.provider]);
const since = computed(() =>
	new Date(props.connection.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
);
const githubNote = computed(() =>
	props.connection.provider === 'github'
		? ' To remove the app from GitHub as well, uninstall it in GitHub settings.'
		: ''
);

function confirm(): void {
	open.value = false;
	emit('revoke');
}
</script>

<template>
	<li class="flex flex-col gap-3 rounded-lg border border-default p-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 flex-col gap-1">
				<h3 class="wrap-break-word font-medium text-highlighted">
					{{ connection.displayName }}
				</h3>
				<p class="text-sm text-muted">{{ label }}, connected {{ since }}</p>
			</div>
			<UBadge
				:color="connection.state === 'active' ? 'success' : 'neutral'"
				variant="subtle"
				:icon="connection.state === 'active' ? 'i-lucide-circle-check' : 'i-lucide-unplug'"
				>{{ connection.state === 'active' ? 'Active' : 'Revoked' }}</UBadge
			>
		</div>
		<div v-if="connection.state === 'active' && canRevoke">
			<UButton
				color="error"
				variant="outline"
				icon="i-lucide-unplug"
				:loading="busy"
				@click="open = true"
				>Revoke</UButton
			>
			<UModal
				v-model:open="open"
				title="Revoke This Connection"
				:description="`Sites that pull from ${connection.displayName} stop pulling. You can connect again later.${githubNote}`"
			>
				<template #footer>
					<div class="flex w-full justify-end gap-3">
						<UButton
							color="neutral"
							variant="outline"
							@click="open = false"
							>Cancel</UButton
						>
						<UButton
							color="error"
							@click="confirm()"
							>Revoke</UButton
						>
					</div>
				</template>
			</UModal>
		</div>
	</li>
</template>
