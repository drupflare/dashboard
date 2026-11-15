<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { PITR_WINDOW_DAYS, RESTORE_LAYER_FACTS } from '~/shared/restore-points';
import { useBackupsStore } from '~/stores/backups';

const props = defineProps<{ orgId: string; siteId: string }>();
const emit = defineEmits<{ close: [] }>();

const backups = useBackupsStore();
const facts = RESTORE_LAYER_FACTS.pitr;

const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');
const local = (date: Date) =>
	`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const now = new Date();
const min = local(new Date(now.getTime() - PITR_WINDOW_DAYS * DAY_MS + 60_000));
const max = local(now);
const moment = ref('');
const understood = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const scheduled = ref<{ operationId: string; undo: string | null } | null>(null);
let request: Promise<void> | null = null;

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const at = computed(() => (moment.value === '' ? NaN : new Date(moment.value).getTime()));
const valid = computed(
	() =>
		Number.isFinite(at.value) &&
		at.value < Date.now() &&
		at.value >= Date.now() - PITR_WINDOW_DAYS * DAY_MS
);

// one request in flight: a second submit while the first is pending reuses it
function submit(): void {
	if (!valid.value || !understood.value) return;
	request ??= schedule().finally(() => {
		request = null;
	});
}

async function schedule(): Promise<void> {
	error.value = null;
	busy.value = true;
	try {
		const operation = await backups.schedulePitr(
			props.orgId,
			props.siteId,
			Math.trunc(at.value),
			crypto.randomUUID()
		);
		scheduled.value = { operationId: operation.id, undo: operation.rollbackPoint ?? null };
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		error.value =
			details?.requires === 'step-up'
				? 'Restoring to a moment needs a fresh sign-in. Confirm it on the Account page, then try again.'
				: failure.message;
	} finally {
		busy.value = false;
	}
}

function onOpenChange(value: boolean): void {
	if (!value) emit('close');
}
</script>

<template>
	<UModal
		:open="true"
		title="Restore to a Moment"
		:description="`Return the site to how it stood at a time in the last ${PITR_WINDOW_DAYS} days.`"
		@update:open="onOpenChange"
	>
		<template #body>
			<div
				v-if="scheduled"
				class="flex flex-col gap-4"
				data-test="scheduled"
			>
				<p class="text-sm text-default">
					The restore is scheduled. The site applies it the next time it starts.
				</p>
				<p
					v-if="scheduled.undo"
					class="text-sm text-default"
				>
					To undo it, keep this undo point:
					<code
						class="break-all"
						data-test="undo"
						>{{ scheduled.undo }}</code
					>
				</p>
				<p
					v-else
					class="text-sm text-default"
				>
					The undo point is saved with the operation. It shows on the progress page once
					the restore is scheduled.
				</p>
				<div class="flex gap-3">
					<UButton :to="`/new/progress/${scheduled.operationId}`">View Progress</UButton>
					<UButton
						color="neutral"
						variant="outline"
						@click="emit('close')"
						>Close</UButton
					>
				</div>
			</div>

			<form
				v-else
				class="flex flex-col gap-4"
				@submit.prevent="submit()"
			>
				<div class="flex flex-col gap-2 text-sm text-default">
					<p class="font-medium text-highlighted">This moves</p>
					<ul class="list-inside list-disc">
						<li
							v-for="item in facts.moves"
							:key="item"
						>
							{{ item }}
						</li>
					</ul>
					<p class="font-medium text-highlighted">This does not move</p>
					<ul class="list-inside list-disc">
						<li
							v-for="item in facts.doesNotMove"
							:key="item"
						>
							{{ item }}
						</li>
					</ul>
				</div>

				<UiField
					id="pitr-moment"
					label="Moment"
					:error="error"
					v-slot="{ describedBy }"
				>
					<input
						id="pitr-moment"
						v-model="moment"
						type="datetime-local"
						required
						:min="min"
						:max="max"
						:class="inputClass"
						:aria-describedby="describedBy"
					/>
				</UiField>

				<label class="flex items-start gap-3 text-sm text-default">
					<input
						v-model="understood"
						type="checkbox"
						class="mt-0.5 size-4 accent-primary"
					/>
					<span
						>I understand the site goes back to that moment and loses what came
						after.</span
					>
				</label>

				<div class="flex gap-3">
					<UButton
						type="submit"
						:loading="busy"
						:disabled="!valid || !understood || busy"
						>Schedule Restore</UButton
					>
					<UButton
						type="button"
						color="neutral"
						variant="outline"
						@click="emit('close')"
						>Cancel</UButton
					>
				</div>
			</form>
		</template>
	</UModal>
</template>
