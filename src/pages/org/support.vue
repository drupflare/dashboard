<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import {
	SUPPORT_GRANT_SCOPES,
	SUPPORT_GRANT_SCOPE_LABELS,
	SUPPORT_GRANT_SCOPE_TEXT,
	type SupportGrantScope,
	type SupportGrantView
} from '~/shared/support';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Support Access' });

const session = useSessionStore();
const org = useOrgStore();
const orgId = computed(() => org.current?.id ?? null);

const grants = ref<SupportGrantView[]>([]);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(): Promise<void> {
	if (!orgId.value) return;
	status.value = 'loading';
	try {
		grants.value = (
			await useApi().get<{ items: SupportGrantView[] }>(`/orgs/${orgId.value}/support-grants`)
		).items;
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());
watch(orgId, () => void load());

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// #region grant access

const scope = ref<SupportGrantScope>('read-metadata');
const hours = ref(24);
const reason = ref('');
const busy = ref(false);
const grantError = ref<string | null>(null);
const needsStepUp = ref(false);

const scopeItems = SUPPORT_GRANT_SCOPES.map((value) => ({
	label: SUPPORT_GRANT_SCOPE_LABELS[value],
	value
}));

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const canGrant = computed(
	() =>
		reason.value.trim() !== '' &&
		Number.isInteger(hours.value) &&
		hours.value >= 1 &&
		hours.value <= 168
);

async function grant(): Promise<void> {
	if (!orgId.value) return;
	grantError.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		await useApi().post(`/orgs/${orgId.value}/support-grants`, {
			scope: scope.value,
			hours: hours.value,
			reason: reason.value.trim()
		});
		reason.value = '';
		await load();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else grantError.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void grant();
}

// #endregion

const revokeError = ref<string | null>(null);

async function revoke(row: SupportGrantView): Promise<void> {
	if (!orgId.value) return;
	revokeError.value = null;
	try {
		await useApi().delete(`/orgs/${orgId.value}/support-grants/${row.id}`);
		await load();
	} catch (cause) {
		revokeError.value = toApiClientError(cause).message;
	}
}
</script>

<template>
	<ClientOnly>
		<div class="flex flex-col gap-6">
			<UiPageHeader
				title="Support Access"
				text="Let Drupflare support into this organization for a set time. Support never reads site content, and every use shows in your audit log."
			/>
			<form
				class="flex max-w-xl flex-col gap-3 rounded-lg border border-default p-4"
				aria-labelledby="grant-support-title"
				@submit.prevent="grant"
			>
				<h2
					id="grant-support-title"
					class="text-lg font-semibold text-highlighted"
				>
					Grant Access
				</h2>
				<UiField
					id="support-scope"
					label="What Support Can Do"
					:hint="SUPPORT_GRANT_SCOPE_TEXT[scope]"
				>
					<template #default="{ describedBy }">
						<USelect
							id="support-scope"
							v-model="scope"
							:items="scopeItems"
							:aria-describedby="describedBy"
							class="w-full"
						/>
					</template>
				</UiField>
				<UiField
					id="support-hours"
					label="Hours of Access"
					hint="From 1 hour up to 7 days (168 hours)."
				>
					<template #default="{ describedBy }">
						<UInput
							id="support-hours"
							v-model.number="hours"
							type="number"
							min="1"
							max="168"
							:aria-describedby="describedBy"
							class="w-full"
						/>
					</template>
				</UiField>
				<UiField
					id="support-reason"
					label="Reason"
				>
					<template #default="{ describedBy }">
						<UInput
							id="support-reason"
							v-model="reason"
							:aria-describedby="describedBy"
							class="w-full"
						/>
					</template>
				</UiField>
				<p
					v-if="grantError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ grantError }}
				</p>
				<div>
					<UButton
						type="submit"
						color="neutral"
						:loading="busy"
						:disabled="!canGrant"
						>Grant Access</UButton
					>
				</div>
				<AccountStepUp
					v-if="needsStepUp"
					@done="stepUpDone()"
					@cancel="needsStepUp = false"
				/>
			</form>

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
				v-else-if="status === 'loading'"
				role="status"
				class="text-sm text-muted"
			>
				Loading support access
			</p>
			<section
				v-else
				class="flex flex-col gap-2"
			>
				<h2 class="text-lg font-semibold text-highlighted">Grants</h2>
				<p
					v-if="grants.length === 0"
					class="text-muted"
				>
					You have not given support access.
				</p>
				<p
					v-if="revokeError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ revokeError }}
				</p>
				<ul class="flex flex-col gap-2 text-sm">
					<li
						v-for="row in grants"
						:key="row.id"
						class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default p-3"
					>
						<span>
							{{ SUPPORT_GRANT_SCOPE_LABELS[row.scope] }}, until
							{{ when(row.expiresAt) }}
							(UTC).
							<span class="text-muted">{{ row.reason }}</span>
							<strong
								v-if="!row.live"
								class="ml-1 text-muted"
								>{{ row.revokedAt === null ? 'Ended' : 'Revoked' }}</strong
							>
						</span>
						<UButton
							v-if="row.live"
							color="neutral"
							variant="outline"
							size="xs"
							@click="revoke(row)"
							>Revoke</UButton
						>
					</li>
				</ul>
			</section>
		</div>
	</ClientOnly>
</template>
