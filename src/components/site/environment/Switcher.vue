<script setup lang="ts">
import {
	ENVIRONMENT_KIND_LABELS,
	ENVIRONMENT_STATUS_LABELS,
	expiryText,
	type EnvironmentStatus
} from '~/shared/environments';
import type { SiteEnvironment } from '~/stores/environments';

const props = defineProps<{
	siteName: string;
	siteHost: string | null;
	environments: SiteEnvironment[];
	deleting: string | null;
}>();
const emit = defineEmits<{ remove: [environment: SiteEnvironment] }>();

const busyStatuses: readonly EnvironmentStatus[] = ['creating', 'deleting'];

const siteUrl = computed(() => (props.siteHost ? `https://${props.siteHost}` : undefined));

const rows = computed(() => {
	const now = Date.now();
	return props.environments.map((environment) => ({
		environment,
		url: `https://${environment.host}`,
		kind: ENVIRONMENT_KIND_LABELS[environment.kind],
		status: ENVIRONMENT_STATUS_LABELS[environment.status],
		busy: busyStatuses.includes(environment.status),
		expiry: environment.ttlAt === null ? null : expiryText(environment.ttlAt, now)
	}));
});
</script>

<template>
	<ul
		class="flex flex-col divide-y divide-default rounded-lg border border-default"
		aria-label="Environments of This Site"
	>
		<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
			<div class="flex flex-col">
				<span class="font-medium text-highlighted">{{ siteName }}</span>
				<span class="text-sm text-muted">Live site</span>
			</div>
			<UButton
				v-if="siteHost"
				:to="siteUrl"
				color="neutral"
				variant="outline"
				size="sm"
				icon="i-lucide-external-link"
				label="Open"
				:aria-label="`Open ${siteHost}`"
			/>
		</li>
		<li
			v-for="row in rows"
			:key="row.environment.id"
			class="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
		>
			<div class="flex flex-col">
				<span class="font-medium text-highlighted">{{ row.kind }}</span>
				<span class="text-sm text-muted"
					>{{ row.environment.host }} - {{ row.status }}</span
				>
				<span
					v-if="row.expiry"
					class="text-sm text-muted"
					>{{ row.expiry }}</span
				>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<template v-if="row.environment.status === 'ready'">
					<UButton
						:to="row.url"
						color="neutral"
						variant="outline"
						size="sm"
						icon="i-lucide-external-link"
						label="Open"
						:aria-label="`Open ${row.environment.host}`"
					/>
				</template>
				<UButton
					color="neutral"
					variant="outline"
					size="sm"
					icon="i-lucide-trash-2"
					:loading="deleting === row.environment.id"
					:disabled="row.busy || deleting !== null"
					:aria-label="`Delete the ${row.kind} environment`"
					label="Delete"
					@click="emit('remove', row.environment)"
				/>
			</div>
		</li>
	</ul>
</template>
