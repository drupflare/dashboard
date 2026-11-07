<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { SITE_HOLD_DAYS } from '~/shared/operation-copy';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';

const props = defineProps<{ orgId: string; siteId: string; name: string }>();

const sites = useSitesStore();
const session = useSessionStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
// one key per opening, so a retry after a dropped answer finds the first request
let idempotencyKey = '';

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show(): void {
	error.value = null;
	needsStepUp.value = false;
	idempotencyKey = crypto.randomUUID();
	open.value = true;
}

function close(): void {
	open.value = false;
}

// some browsers do not focus a button on click, so the dialog cannot rely on the last focus
watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function remove(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		const operation = await sites.remove(props.orgId, props.siteId, props.name, idempotencyKey);
		open.value = false;
		await navigateTo(`/new/progress/${operation.id}`);
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
	void remove();
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			color="error"
			variant="outline"
			icon="i-lucide-trash-2"
			@click="show()"
			>Delete Site</UButton
		>
		<UModal
			v-model:open="open"
			title="Delete This Site"
			:description="`Delete ${name} from this organization.`"
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-2 text-sm text-default">
						<p>The site stops serving early in the delete and leaves your list.</p>
						<p>
							Its address stays reserved for {{ SITE_HOLD_DAYS }} days, so nobody else
							can claim it. The site's data is kept until then, and its backups are
							kept.
						</p>
						<p>There is no undo in the dashboard.</p>
					</div>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<UiConfirmTyped
						:expected="name"
						label="Site Name"
						action="Delete Site"
						:busy="busy"
						@confirm="remove()"
						@cancel="close()"
					/>

					<AccountStepUp
						v-if="needsStepUp"
						@done="stepUpDone()"
						@cancel="needsStepUp = false"
					/>
				</div>
			</template>
		</UModal>
	</div>
</template>
