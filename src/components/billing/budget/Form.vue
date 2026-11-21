<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { validatePercent, type Enforcement } from '~/shared/budget-rules';
import type { BudgetBody, BudgetView } from '~/shared/budgets';
import { SPEND_BUDGET } from '~/shared/plans';
import { useBudgetStore } from '~/stores/budget';

const props = defineProps<{
	scope: 'org' | 'site';
	orgId: string;
	siteId?: string;
	reply: BudgetView;
	// the organization budget a site cannot pass; null is no ceiling
	ceiling: number | null;
	canManage: boolean;
}>();

const budget = useBudgetStore();

const LABEL = 'Budget (Percent of Included Views)';
const MIN = SPEND_BUDGET.minPercent.value;
const MAX = SPEND_BUDGET.maxPercent.value;

const percent = ref(MIN);
const enforcement = ref<Enforcement>('block');
// the number field's own text, so a typed 437.3 stays 437.3
const text = ref('');
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const failure = ref<ApiClientError | null>(null);
const saving = ref(false);
const waiting = ref<(() => Promise<void>) | null>(null);
const undo = ref<{ text: string; restore: BudgetBody } | null>(null);

// a site with no row of its own, under a pooled allowance, shows the shared default until set
const usingDefault = computed(
	() => props.scope === 'site' && props.reply.percent !== null && !props.reply.ownerSet
);
const disabled = computed(() => !props.canManage || saving.value);
const max = computed(() => props.ceiling ?? MAX);
const hint = `Between ${MIN} and ${MAX} percent. One decimal place is allowed.`;
const placeholder = computed(() =>
	usingDefault.value ? `Using the shared default: ${props.reply.percent} percent` : undefined
);

function clampNote(ceiling: number): string {
	return `The organization budget of ${ceiling} percent is the most a site can use.`;
}

function sync(): void {
	let next = props.reply.percent ?? props.ceiling ?? SPEND_BUDGET.defaultPercent.value;
	note.value = null;
	if (props.ceiling !== null && next > props.ceiling) {
		next = props.ceiling;
		note.value = clampNote(props.ceiling);
	}
	percent.value = next;
	enforcement.value = props.reply.enforcement ?? 'block';
	text.value = usingDefault.value ? '' : String(next);
	error.value = null;
}
watch(() => props.reply, sync, { immediate: true });

// a raise, or a switch from hard to soft, loosens protection; the server decides the same
function raises(
	before: { percent: number | null; enforcement: Enforcement | null },
	next: BudgetBody
) {
	if (before.percent === null) return false;
	return (
		next.percent > before.percent ||
		(before.enforcement === 'block' && next.enforcement === 'alert')
	);
}

// v-model on a number input holds a number, so the text is read back as a string
function typing(): void {
	const raw = String(text.value).trim();
	const value = Number(raw);
	if (raw !== '' && Number.isFinite(value)) percent.value = value;
	error.value = null;
}

function blurred(): void {
	const raw = String(text.value).trim();
	const result = validatePercent(raw === '' ? Number.NaN : Number(raw));
	if (!result.ok) {
		if (raw === '' && usingDefault.value) return;
		error.value = result.message;
		return;
	}
	let next = result.percent;
	note.value = null;
	if (props.ceiling !== null && next > props.ceiling) {
		next = props.ceiling;
		note.value = clampNote(props.ceiling);
	}
	error.value = null;
	percent.value = next;
	text.value = String(next);
	void commit(next, enforcement.value);
}

function onSlide(next: number): void {
	percent.value = next;
	text.value = String(next);
	error.value = null;
	note.value = null;
}

async function commit(nextPercent: number, nextEnforcement: Enforcement): Promise<void> {
	if (!props.canManage) return;
	if (
		!usingDefault.value &&
		props.reply.percent === nextPercent &&
		props.reply.enforcement === nextEnforcement
	) {
		return;
	}
	await attempt(
		{ percent: nextPercent, enforcement: nextEnforcement },
		{ percent: props.reply.percent, enforcement: props.reply.enforcement }
	);
}

async function attempt(
	body: BudgetBody,
	before: { percent: number | null; enforcement: Enforcement | null }
): Promise<void> {
	saving.value = true;
	failure.value = null;
	undo.value = null;
	try {
		if (props.scope === 'org') await budget.saveOrg(props.orgId, body);
		else await budget.saveSite(props.orgId, props.siteId ?? '', body);
		if (before.percent !== null && !raises(before, body)) {
			undo.value = {
				text: `Budget set to ${body.percent} percent.`,
				restore: { percent: before.percent, enforcement: before.enforcement ?? 'block' }
			};
		}
	} catch (cause) {
		const details = toApiClientError(cause).details as { requires?: string } | null;
		if (details?.requires === 'step-up') waiting.value = () => attempt(body, before);
		else failure.value = toApiClientError(cause);
	} finally {
		saving.value = false;
	}
}

function stepUpDone(): void {
	const retry = waiting.value;
	waiting.value = null;
	if (retry) void retry();
}

function stepUpCancelled(): void {
	waiting.value = null;
	sync();
}

function restore(): void {
	const change = undo.value;
	if (!change) return;
	void attempt(change.restore, {
		percent: props.reply.percent,
		enforcement: props.reply.enforcement
	});
}
</script>

<template>
	<div class="flex flex-col gap-8">
		<p
			v-if="!canManage"
			class="text-sm text-muted"
		>
			Only the owner or a billing member can change this budget.
		</p>

		<AccountStepUp
			v-if="waiting"
			@done="stepUpDone()"
			@cancel="stepUpCancelled()"
		/>

		<UiField
			id="budget-percent"
			:label="LABEL"
			:hint="hint"
			:error="error"
		>
			<template #default="{ describedBy }">
				<div class="flex flex-col gap-4">
					<div class="flex items-center gap-4">
						<BillingBudgetSlider
							class="flex-1"
							:label="LABEL"
							:percent="percent"
							:ceiling="ceiling"
							:disabled="disabled"
							@update:percent="onSlide"
							@commit="commit(percent, enforcement)"
						/>
						<input
							id="budget-percent"
							v-model="text"
							type="number"
							inputmode="decimal"
							:min="MIN"
							:max="max"
							step="0.1"
							:placeholder="placeholder"
							:disabled="disabled"
							:aria-describedby="describedBy"
							class="w-28 rounded-md border border-default bg-default px-3 py-2 text-default tabular-nums placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
							@input="typing"
							@blur="blurred"
							@keydown.enter.prevent="blurred"
						/>
					</div>
					<p
						v-if="note"
						class="text-sm text-muted"
					>
						{{ note }}
					</p>
				</div>
			</template>
		</UiField>

		<BillingBudgetDollars
			:percent="percent"
			:allowance-views="reply.allowanceViews"
			:saved-percent="reply.percent"
			:saved="reply.dollars"
			:overage-billed="reply.overageBilled"
		/>

		<BillingBudgetEnforcement
			v-model="enforcement"
			:applies-within="reply.appliesWithin"
			:disabled="disabled"
			@change="(value) => commit(percent, value)"
		/>

		<div
			v-if="undo"
			role="status"
			class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-default p-4 text-sm"
		>
			<p>{{ undo.text }}</p>
			<UButton
				color="neutral"
				variant="outline"
				:disabled="saving"
				@click="restore()"
			>
				Undo
			</UButton>
		</div>

		<UiErrorState
			v-if="failure"
			title="Could Not Save the Budget"
			:text="failure.message"
			:request-id="failure.requestId"
		/>

		<section class="flex flex-col gap-4">
			<h3 class="text-base font-semibold text-highlighted">Status</h3>
			<BillingBudgetState :reply="reply" />
		</section>

		<BillingBudgetAlerts :reply="reply" />
	</div>
</template>
