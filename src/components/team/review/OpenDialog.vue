<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { REVIEW_DUE_DAYS, type ReviewView } from '~/shared/access-reviews';
import { useAccessReviewsStore } from '~/stores/access-reviews';

const props = defineProps<{
	orgId: string;
	departments: { label: string; value: string }[];
}>();
const emit = defineEmits<{ created: [review: ReviewView] }>();

const store = useAccessReviewsStore();

const WHOLE = 'organization';
const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const scope = ref(WHOLE);
const days = ref<number | null>(REVIEW_DUE_DAYS);
const busy = ref(false);
const error = ref<string | null>(null);

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function show(): void {
	scope.value = WHOLE;
	days.value = REVIEW_DUE_DAYS;
	error.value = null;
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function submit(): Promise<void> {
	error.value = null;
	const count = days.value;
	if (count === null || !Number.isInteger(count) || count < 1 || count > 365) {
		error.value = 'Enter a whole number of days from 1 to 365.';
		return;
	}
	busy.value = true;
	try {
		const created = await store.create(props.orgId, { scope: scope.value, dueInDays: count });
		open.value = false;
		emit('created', created);
	} catch (cause) {
		error.value = toApiClientError(cause).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			icon="i-lucide-plus"
			@click="show()"
			>Open a Review</UButton
		>
		<UModal
			v-model:open="open"
			title="Open an Access Review"
			description="The review takes a copy of who and what has access right now. Later changes do not alter it."
		>
			<template #body>
				<form
					class="flex flex-col gap-4"
					@submit.prevent="submit()"
				>
					<UFormField label="What to Review">
						<USelect
							v-model="scope"
							:items="[
								{ label: 'The Whole Organization', value: WHOLE },
								...departments
							]"
							aria-label="What to Review"
							class="w-full"
						/>
					</UFormField>
					<UiField
						id="review-days"
						label="Decide Within (Days)"
						v-slot="{ describedBy }"
					>
						<input
							id="review-days"
							v-model.number="days"
							type="number"
							min="1"
							max="365"
							step="1"
							aria-required="true"
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>
					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="busy"
							>Open Review</UButton
						>
						<UButton
							type="button"
							color="neutral"
							variant="outline"
							@click="open = false"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</UModal>
	</div>
</template>
