<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import {
	BREAK_GLASS_REASON_MIN,
	SUPPORT_GRANT_SCOPE_LABELS,
	type BreakGlassView,
	type SupportGrantView
} from '~/shared/support';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Support Access' });

interface Listing {
	grants: SupportGrantView[];
	breakGlass: BreakGlassView[];
}

const session = useSessionStore();
const data = ref<Listing | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(): Promise<void> {
	status.value = 'loading';
	try {
		data.value = await adminGet<Listing>('/admin/support-grants');
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// #region break-glass

const organizationId = ref('');
const reason = ref('');
const busy = ref(false);
const startError = ref<string | null>(null);
const needsStepUp = ref(false);
const started = ref<BreakGlassView | null>(null);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const canStart = computed(
	() => organizationId.value.trim() !== '' && reason.value.trim().length >= BREAK_GLASS_REASON_MIN
);

async function start(): Promise<void> {
	startError.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		started.value = await useApi().post<BreakGlassView>('/admin/break-glass', {
			organizationId: organizationId.value.trim(),
			reason: reason.value.trim()
		});
		reason.value = '';
		await load();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else startError.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void start();
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
			title="Support Access"
			text="Support acts inside an organization only with a live grant from its owner or admin, or through break-glass access. Every use is audited in the organization's log and in the platform log."
		/>
		<UiErrorState
			v-if="status === 'error'"
			title="Support Access Could Not Load"
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
			v-else-if="status === 'loading' || data === null"
			role="status"
			class="text-sm text-muted"
		>
			Loading support access
		</p>
		<template v-else>
			<section class="flex flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Live Grants</h2>
				<p
					v-if="data.grants.length === 0"
					class="text-muted"
				>
					No organization has a live grant.
				</p>
				<div
					v-else
					class="overflow-x-auto rounded-lg border border-default"
					tabindex="0"
					role="region"
					aria-label="Support Grants"
				>
					<table class="w-full text-left text-sm">
						<thead class="bg-elevated text-muted">
							<tr>
								<th
									scope="col"
									class="px-4 py-3 font-medium"
								>
									Organization
								</th>
								<th
									scope="col"
									class="px-4 py-3 font-medium"
								>
									Scope
								</th>
								<th
									scope="col"
									class="px-4 py-3 font-medium"
								>
									Granted By
								</th>
								<th
									scope="col"
									class="px-4 py-3 font-medium"
								>
									Ends
								</th>
								<th
									scope="col"
									class="px-4 py-3 font-medium"
								>
									Reason
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="grant in data.grants"
								:key="grant.id"
								class="border-t border-default align-top"
							>
								<td class="px-4 py-3 font-mono text-xs">
									{{ grant.organizationId }}
								</td>
								<td class="px-4 py-3">
									{{ SUPPORT_GRANT_SCOPE_LABELS[grant.scope] }}
								</td>
								<td class="px-4 py-3 font-mono text-xs">{{ grant.grantedBy }}</td>
								<td class="px-4 py-3">{{ when(grant.expiresAt) }}</td>
								<td class="px-4 py-3">{{ grant.reason }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>

			<form
				class="flex max-w-xl flex-col gap-3 rounded-lg border border-default p-4"
				aria-labelledby="break-glass-title"
				@submit.prevent="start"
			>
				<h2
					id="break-glass-title"
					class="text-lg font-semibold text-highlighted"
				>
					Break-Glass Access
				</h2>
				<p class="text-sm text-muted">
					Opens one hour of access without a grant. Every owner of the organization is
					emailed at once and the reason is recorded in both logs. Needs step-up. You can
					start it only a few times a day.
				</p>
				<UiField
					id="glass-org"
					label="Organization ID"
				>
					<template #default="{ describedBy }">
						<UInput
							id="glass-org"
							v-model="organizationId"
							:aria-describedby="describedBy"
							class="w-full"
						/>
					</template>
				</UiField>
				<UiField
					id="glass-reason"
					label="Reason"
					:hint="`At least ${BREAK_GLASS_REASON_MIN} characters. The owners read this.`"
				>
					<template #default="{ describedBy }">
						<UTextarea
							id="glass-reason"
							v-model="reason"
							:aria-describedby="describedBy"
							class="w-full"
						/>
					</template>
				</UiField>
				<p
					v-if="startError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ startError }}
				</p>
				<p
					v-if="started"
					role="status"
					class="text-sm"
				>
					Access is open until {{ when(started.expiresAt) }}.
					{{ started.ownersNotified }} owner{{ started.ownersNotified === 1 ? '' : 's' }}
					emailed.
				</p>
				<div>
					<UButton
						type="submit"
						color="error"
						:loading="busy"
						:disabled="!canStart"
						>Start Break-Glass Access</UButton
					>
				</div>
				<AccountStepUp
					v-if="needsStepUp"
					@done="stepUpDone()"
					@cancel="needsStepUp = false"
				/>
			</form>

			<section class="flex flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Recent Break-Glass Starts</h2>
				<p
					v-if="data.breakGlass.length === 0"
					class="text-muted"
				>
					None yet.
				</p>
				<ul
					v-else
					class="flex flex-col gap-2 text-sm"
				>
					<li
						v-for="event in data.breakGlass"
						:key="event.id"
						class="rounded-lg border border-default p-3"
					>
						<span class="font-mono text-xs">{{ event.organizationId }}</span>
						by <span class="font-mono text-xs">{{ event.admin }}</span
						>, started {{ when(event.startedAt) }},
						{{ event.live ? 'still open' : 'ended' }}.
						<span class="text-muted">{{ event.reason }}</span>
					</li>
				</ul>
			</section>
		</template>
	</div>
</template>
