<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Abuse' });

type AbuseState = 'open' | 'reviewing' | 'actioned' | 'dismissed';

interface Report {
	id: string;
	siteId: string;
	organizationId: string;
	source: 'report' | 'automatic';
	reason: string;
	state: AbuseState;
	reviewer: string | null;
	notes: string | null;
	createdAt: number;
	updatedAt: number;
}

// the moves the server allows; actioned and dismissed are final
const NEXT: Record<AbuseState, AbuseState[]> = {
	open: ['reviewing', 'actioned', 'dismissed'],
	reviewing: ['open', 'actioned', 'dismissed'],
	actioned: [],
	dismissed: []
};

const LABEL: Record<AbuseState, string> = {
	open: 'Open',
	reviewing: 'Reviewing',
	actioned: 'Actioned',
	dismissed: 'Dismissed'
};

const session = useSessionStore();
const filter = ref<'all' | AbuseState>('all');
const reports = ref<Report[]>([]);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const actionError = ref<string | null>(null);

async function load(): Promise<void> {
	status.value = 'loading';
	try {
		const query: Record<string, string> = { limit: '100' };
		if (filter.value !== 'all') query.state = filter.value;
		const page = await adminGet<{ items: Report[] }>('/admin/abuse', query);
		reports.value = page.items;
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());
watch(filter, () => void load());

const filters = [
	{ label: 'All', value: 'all' },
	{ label: 'Open', value: 'open' },
	{ label: 'Reviewing', value: 'reviewing' },
	{ label: 'Actioned', value: 'actioned' },
	{ label: 'Dismissed', value: 'dismissed' }
];

async function move(report: Report, state: AbuseState): Promise<void> {
	actionError.value = null;
	try {
		await useApi().put<Report>(`/admin/abuse/${report.id}/state`, { state, notes: null });
		await load();
	} catch (cause) {
		actionError.value = toApiClientError(cause).message;
	}
}

async function suspend(report: Report): Promise<void> {
	actionError.value = null;
	try {
		await useApi().post(`/admin/abuse/${report.id}/suspend`, {});
		await load();
	} catch (cause) {
		actionError.value = toApiClientError(cause).message;
	}
}

// #region open a report

const siteId = ref('');
const reason = ref('');
const opening = ref(false);
const openError = ref<string | null>(null);

async function open(): Promise<void> {
	openError.value = null;
	opening.value = true;
	try {
		await useApi().post<Report>('/admin/abuse', {
			siteId: siteId.value.trim(),
			reason: reason.value.trim(),
			source: 'report'
		});
		siteId.value = '';
		reason.value = '';
		await load();
	} catch (cause) {
		openError.value = toApiClientError(cause).message;
	} finally {
		opening.value = false;
	}
}

// #endregion
</script>

<template>
	<UiEmptyState
		v-if="session.me !== undefined && session.me?.platformRole !== 'admin'"
		icon="i-lucide-file-question"
		title="Page Not Found"
		text="There is nothing at this address."
	/>
	<div
		v-else
		class="flex flex-col gap-6"
	>
		<UiPageHeader
			title="Abuse Queue"
			text="Reports on sites, from a person or from an automatic check. Every move is audited."
		/>

		<form
			class="flex max-w-xl flex-col gap-3 rounded-lg border border-default p-4"
			aria-labelledby="open-report-title"
			@submit.prevent="open"
		>
			<h2
				id="open-report-title"
				class="text-lg font-semibold text-highlighted"
			>
				Open a Report
			</h2>
			<UiField
				id="report-site"
				label="Site ID"
			>
				<template #default="{ describedBy }">
					<UInput
						id="report-site"
						v-model="siteId"
						:aria-describedby="describedBy"
						class="w-full"
					/>
				</template>
			</UiField>
			<UiField
				id="report-reason"
				label="Reason"
			>
				<template #default="{ describedBy }">
					<UInput
						id="report-reason"
						v-model="reason"
						:aria-describedby="describedBy"
						class="w-full"
					/>
				</template>
			</UiField>
			<p
				v-if="openError"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ openError }}
			</p>
			<div>
				<UButton
					type="submit"
					color="neutral"
					:loading="opening"
					:disabled="siteId.trim() === '' || reason.trim() === ''"
					>Open Report</UButton
				>
			</div>
		</form>

		<UTabs
			v-model="filter"
			:items="filters"
			:content="false"
			color="neutral"
			variant="link"
		/>
		<p
			v-if="actionError"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ actionError }}
		</p>
		<UiErrorState
			v-if="status === 'error'"
			title="The Queue Could Not Load"
			:text="error"
		>
			<UButton
				color="neutral"
				variant="outline"
				@click="load()"
				>Try Again</UButton
			>
		</UiErrorState>
		<p
			v-else-if="status === 'loading'"
			role="status"
			class="text-sm text-muted"
		>
			Loading the queue
		</p>
		<p
			v-else-if="reports.length === 0"
			class="text-muted"
		>
			No reports in this view.
		</p>
		<div
			v-else
			class="overflow-x-auto rounded-lg border border-default"
			tabindex="0"
			role="region"
			aria-label="Abuse Reports"
		>
			<table class="w-full text-left text-sm">
				<thead class="bg-elevated text-muted">
					<tr>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Reason
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Source
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Site
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							State
						</th>
						<th
							scope="col"
							class="px-4 py-3 font-medium"
						>
							Move To
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="report in reports"
						:key="report.id"
						class="border-t border-default align-top"
					>
						<td class="px-4 py-3">{{ report.reason }}</td>
						<td class="px-4 py-3">
							{{ report.source === 'report' ? 'Report' : 'Automatic' }}
						</td>
						<td class="px-4 py-3 font-mono text-xs">{{ report.siteId }}</td>
						<td class="px-4 py-3">{{ LABEL[report.state] }}</td>
						<td class="px-4 py-3">
							<div class="flex flex-wrap gap-1">
								<UButton
									v-for="next in NEXT[report.state]"
									:key="next"
									color="neutral"
									variant="outline"
									size="xs"
									@click="move(report, next)"
									>{{ LABEL[next] }}</UButton
								>
								<UButton
									v-if="report.state !== 'dismissed'"
									color="error"
									variant="outline"
									size="xs"
									@click="suspend(report)"
									>Suspend Site</UButton
								>
								<span
									v-if="report.state === 'dismissed'"
									class="text-muted"
									>None</span
								>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
