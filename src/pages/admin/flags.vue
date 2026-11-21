<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError, useApi } from '~/composables/useApi';
import { GLOBAL_CONFIRMATION } from '~/shared/health/repair-copy';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });

interface FlagView {
	key: string;
	value: boolean;
	setBy: string | null;
	setAt: number | null;
}

const COPY: Record<string, { title: string; text: string }> = {
	'signups.paused': {
		title: 'Pause Sign-ups',
		text: 'Stops new accounts from being created. Existing people still sign in.'
	},
	'notifications.paused': {
		title: 'Pause Optional Mail',
		text: 'Stops optional mail. Essential mail, such as sign-in codes, still goes out.'
	},
	'promotion.stopped': {
		title: 'Stop Release Promotion',
		text: 'Refuses to start a release rollout while it is on, and stops a running one at its next ring.'
	},
	'ladder.auto': {
		title: 'Automatic Repair',
		text: 'Lets the repair ladder run fixes on its own. Changing it needs the confirmation word.'
	}
};

const session = useSessionStore();
const flags = ref<FlagView[]>([]);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(): Promise<void> {
	status.value = 'loading';
	try {
		flags.value = (await adminGet<{ flags: FlagView[] }>('/admin/flags')).flags;
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());

// #region set a switch

const target = ref<FlagView | null>(null);
const confirmation = ref('');
const busy = ref(false);
const setError = ref<string | null>(null);
const needsStepUp = ref(false);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function ask(flag: FlagView): void {
	target.value = flag;
	confirmation.value = '';
	setError.value = null;
	needsStepUp.value = false;
}

async function apply(): Promise<void> {
	if (target.value === null) return;
	setError.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		const flag = target.value;
		await useApi().put<FlagView>(`/admin/flags/${flag.key}`, {
			value: !flag.value,
			...(flag.key === 'ladder.auto' ? { confirmation: confirmation.value } : {})
		});
		target.value = null;
		await load();
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else setError.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void apply();
}

// #endregion

const canApply = computed(() =>
	target.value?.key === 'ladder.auto' ? confirmation.value === GLOBAL_CONFIRMATION : true
);

function whoAndWhen(flag: FlagView): string {
	if (flag.setAt === null) return 'Never changed';
	const when = new Date(flag.setAt).toISOString().slice(0, 16).replace('T', ' ');
	return `${flag.setBy ?? 'Unknown'}, ${when}`;
}

useHead({ title: 'Platform Switches' });
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
			title="Platform Switches"
			text="Kill switches for the whole platform. Each change needs a recent sign-in check and is audited."
		/>
		<UiErrorState
			v-if="status === 'error'"
			title="Switches Could Not Load"
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
			Loading the switches
		</p>
		<ul
			v-else
			class="flex max-w-2xl flex-col gap-4"
		>
			<li
				v-for="flag in flags"
				:key="flag.key"
				class="flex flex-col gap-2 rounded-lg border border-default p-4"
			>
				<div class="flex items-center justify-between gap-4">
					<h2 class="font-semibold text-highlighted">
						{{ COPY[flag.key]?.title ?? flag.key }}
					</h2>
					<span class="text-sm">{{ flag.value ? 'On' : 'Off' }}</span>
				</div>
				<p class="text-sm text-muted">{{ COPY[flag.key]?.text }}</p>
				<p class="text-xs text-muted">Last changed by {{ whoAndWhen(flag) }}</p>
				<div>
					<UButton
						color="neutral"
						variant="outline"
						@click="ask(flag)"
						>{{ flag.value ? 'Turn Off' : 'Turn On' }}</UButton
					>
				</div>
			</li>
		</ul>

		<form
			v-if="target !== null"
			class="flex max-w-2xl flex-col gap-3 rounded-lg border border-default p-4"
			aria-labelledby="flag-change-title"
			@submit.prevent="apply"
		>
			<h2
				id="flag-change-title"
				class="text-lg font-semibold text-highlighted"
			>
				{{ target.value ? 'Turn Off' : 'Turn On' }}
				{{ COPY[target.key]?.title ?? target.key }}
			</h2>
			<UiField
				v-if="target.key === 'ladder.auto'"
				id="flag-confirmation"
				label="Confirmation Word"
				:hint="`Type ${GLOBAL_CONFIRMATION} to change automatic repair.`"
			>
				<template #default="{ describedBy }">
					<UInput
						id="flag-confirmation"
						v-model="confirmation"
						:aria-describedby="describedBy"
						class="w-full"
					/>
				</template>
			</UiField>
			<p
				v-if="setError"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ setError }}
			</p>
			<div class="flex gap-2">
				<UButton
					type="submit"
					color="neutral"
					:loading="busy"
					:disabled="!canApply"
					>Confirm Change</UButton
				>
				<UButton
					color="neutral"
					variant="ghost"
					@click="target = null"
					>Cancel</UButton
				>
			</div>
			<AccountStepUp
				v-if="needsStepUp"
				@done="stepUpDone()"
				@cancel="needsStepUp = false"
			/>
		</form>
	</div>
</template>
