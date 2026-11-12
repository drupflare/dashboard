<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { adoptRefusalReason } from '~/shared/operation-copy';
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
// one key per opening, so a press after a dropped answer finds the first request
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

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function adopt(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		const operation = await sites.adopt(props.orgId, props.siteId, idempotencyKey);
		open.value = false;
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as { requires?: string } | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else error.value = adoptRefusalReason(failure);
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void adopt();
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			color="neutral"
			variant="outline"
			icon="i-lucide-arrow-right-left"
			@click="show()"
			>Adopt</UButton
		>
		<UModal
			v-model:open="open"
			title="Adopt This Site"
			:description="`Move ${name} under managed operation.`"
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-2 text-sm text-default">
						<p>
							Drupflare copies this site's database into a new managed site on a
							Drupflare address. The new site is ready in a few minutes.
						</p>
						<p>
							Your current site is not changed or deleted, and it keeps running where
							it is. Your own domain stays on it.
						</p>
						<p>
							The copy is one-way. Changes you make to either site afterward are not
							shared with the other.
						</p>
						<p>
							The copy covers the database. Uploaded files such as images and
							documents are not copied yet.
						</p>
						<p>
							A database above 16 MiB cannot be copied yet. If yours is larger, the
							adoption stops before it creates anything.
						</p>
					</div>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<div class="flex gap-3">
						<UButton
							:loading="busy"
							:disabled="busy"
							@click="adopt()"
							>Adopt Site</UButton
						>
						<UButton
							color="neutral"
							variant="outline"
							@click="close()"
							>Cancel</UButton
						>
					</div>

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
