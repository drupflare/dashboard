<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import type { PlaneConnectionView } from '~/shared/plane-connections';
import { usePlanesStore } from '~/stores/planes';
import { useSessionStore } from '~/stores/session';

const props = defineProps<{ orgId: string; connection: PlaneConnectionView }>();

const planes = usePlanesStore();
const session = useSessionStore();

const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>('trigger');
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
// sites that still run on the account; revoking anyway names each one
const using = ref<string[]>([]);
const force = ref(false);
const result = ref<string | null>(null);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

function show(): void {
	error.value = null;
	needsStepUp.value = false;
	using.value = [];
	force.value = false;
	result.value = null;
	open.value = true;
}

watch(open, (value) => {
	if (!value) void nextTick(() => trigger.value?.$el.focus());
});

async function revoke(): Promise<void> {
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		const done = await planes.revoke(
			props.orgId,
			props.connection.id,
			force.value ? using.value : []
		);
		result.value = done.message;
	} catch (cause) {
		const failure = toApiClientError(cause);
		const details = failure.details as {
			requires?: string;
			reason?: string;
			siteIds?: string[];
		} | null;
		if (details?.requires === 'step-up') needsStepUp.value = true;
		else if (details?.reason === 'sites_use_connection') using.value = details.siteIds ?? [];
		else error.value = failure.message;
	} finally {
		busy.value = false;
	}
}

function stepUpDone(): void {
	needsStepUp.value = false;
	void revoke();
}
</script>

<template>
	<div>
		<UButton
			ref="trigger"
			color="error"
			variant="outline"
			icon="i-lucide-unplug"
			@click="show()"
			>Revoke</UButton
		>
		<UModal
			v-model:open="open"
			title="Revoke This Connection"
			:description="`Stop using ${connection.accountName}.`"
		>
			<template #body>
				<div
					v-if="result"
					class="flex flex-col gap-4"
				>
					<p
						role="status"
						class="text-sm text-default"
					>
						{{ result }}
					</p>
					<div>
						<UButton
							color="neutral"
							@click="open = false"
							>Close</UButton
						>
					</div>
				</div>
				<div
					v-else
					class="flex flex-col gap-4"
				>
					<div class="flex flex-col gap-2 text-sm text-default">
						<p>
							Drupflare wipes the stored token. It can no longer create, update or
							remove anything in this account.
						</p>
						<p>
							Sites already in the account keep serving. To manage them again, connect
							the account again.
						</p>
					</div>

					<div
						v-if="using.length > 0"
						class="flex flex-col gap-2 text-sm text-default"
					>
						<p role="alert">
							These sites still run on this account. After a revoke, Drupflare cannot
							update or remove them.
						</p>
						<ul class="list-disc pl-5 font-mono text-xs">
							<li
								v-for="id in using"
								:key="id"
							>
								{{ id }}
							</li>
						</ul>
						<label class="flex items-start gap-2">
							<input
								v-model="force"
								type="checkbox"
								class="mt-1"
							/>
							<span>Revoke anyway and leave these sites running.</span>
						</label>
					</div>

					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>

					<UiConfirmTyped
						:expected="connection.accountName"
						label="Account Name"
						action="Revoke Connection"
						:busy="busy || (using.length > 0 && !force)"
						@confirm="revoke()"
						@cancel="open = false"
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
