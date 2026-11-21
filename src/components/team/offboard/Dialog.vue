<script setup lang="ts">
import { toApiClientError, useApi } from '~/composables/useApi';
import {
	OFFBOARD_EFFECT_LABEL,
	type OffboardBody,
	type OffboardResult
} from '~/shared/offboarding';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{
	orgId: string;
	memberId: string;
	memberName: string;
	// the other members who can take over a service account
	candidates: { userId: string; label: string }[];
}>();
const emit = defineEmits<{ done: [result: OffboardResult] }>();
const open = defineModel<boolean>('open', { required: true });

const session = useSessionStore();

// the select refuses an empty value, so "nobody" has a name of its own
const NONE = 'none';
const plan = ref<OffboardResult | null>(null);
const transferTo = ref(NONE);
const keepDelegations = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
const finished = ref<OffboardResult | null>(null);

const path = computed(
	() =>
		`/orgs/${encodeURIComponent(props.orgId)}/members/${encodeURIComponent(props.memberId)}/offboard`
);

const hasAccounts = computed(
	() => plan.value?.effects.some((e) => e.kind.startsWith('service-account')) ?? false
);
const hasDelegations = computed(
	() =>
		(plan.value?.effects.some((e) => e.kind === 'delegation') ?? false) ||
		(plan.value?.kept.length ?? 0) > 0
);
const choices = computed(() => [
	{ label: 'Nobody (Disable Them)', value: NONE },
	...props.candidates.map((c) => ({ label: c.label, value: c.userId }))
]);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const body = (dryRun: boolean): OffboardBody => ({
	dryRun,
	...(transferTo.value === NONE ? {} : { transferTo: transferTo.value }),
	...(keepDelegations.value ? { keepDelegations: true } : {})
});

async function preview(): Promise<void> {
	error.value = null;
	loading.value = true;
	try {
		plan.value = await useApi().post<OffboardResult>(path.value, body(true));
	} catch (cause) {
		plan.value = null;
		error.value = toApiClientError(cause).message;
	} finally {
		loading.value = false;
	}
}

watch(
	open,
	(value) => {
		if (!value) return;
		plan.value = null;
		finished.value = null;
		transferTo.value = NONE;
		keepDelegations.value = false;
		needsStepUp.value = false;
		void preview();
	},
	{ immediate: true }
);

watch([transferTo, keepDelegations], () => {
	if (open.value && finished.value === null) void preview();
});

async function run(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		finished.value = await useApi().post<OffboardResult>(path.value, body(false));
		emit('done', finished.value);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else error.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void run();
}
</script>

<template>
	<UModal
		v-model:open="open"
		title="Offboard This Member"
		:description="`Remove ${memberName} from everything in this organization.`"
	>
		<template #body>
			<div
				v-if="finished"
				class="flex flex-col gap-4"
			>
				<p class="text-sm text-default">
					{{ memberName }} is offboarded. {{ finished.effects.length }}
					{{ finished.effects.length === 1 ? 'change was' : 'changes were' }} made, and
					each one is in the audit log.
				</p>
				<UButton
					color="neutral"
					class="self-start"
					@click="open = false"
					>Close</UButton
				>
			</div>
			<AccountStepUp
				v-else-if="needsStepUp"
				@done="stepUpDone()"
				@cancel="needsStepUp = false"
			/>
			<div
				v-else
				class="flex flex-col gap-4"
			>
				<p class="text-sm text-muted">
					This is what will happen. Nothing changes until you press Offboard.
				</p>
				<USkeleton
					v-if="loading && !plan"
					class="h-24 w-full"
				/>
				<ul
					v-else-if="plan"
					class="flex flex-col gap-1 rounded-md border border-default px-3 py-2 text-sm"
					aria-label="Changes"
				>
					<li
						v-for="effect in plan.effects"
						:key="`${effect.kind}:${effect.ref}`"
						class="text-default"
					>
						{{ OFFBOARD_EFFECT_LABEL[effect.kind] }}:
						<span class="text-highlighted">{{ effect.label }}</span>
					</li>
					<li
						v-for="entry in plan.kept"
						:key="`kept:${entry.ref}`"
						class="text-muted"
					>
						Kept in place: {{ entry.label }}
					</li>
				</ul>

				<UFormField
					v-if="hasAccounts"
					label="Hand Service Accounts To"
				>
					<USelect
						v-model="transferTo"
						:items="choices"
						aria-label="Hand Service Accounts To"
						class="w-full"
					/>
				</UFormField>
				<label
					v-if="hasDelegations"
					class="flex items-start gap-2 text-sm text-default"
				>
					<input
						v-model="keepDelegations"
						type="checkbox"
						class="mt-0.5 size-4 shrink-0"
					/>
					Keep the agency access this person created
				</label>

				<p
					v-if="error"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ error }}
				</p>
				<div class="flex gap-3">
					<UButton
						color="error"
						:loading="busy"
						:disabled="!plan"
						@click="run()"
						>Offboard</UButton
					>
					<UButton
						color="neutral"
						variant="outline"
						@click="open = false"
						>Cancel</UButton
					>
				</div>
			</div>
		</template>
	</UModal>
</template>
