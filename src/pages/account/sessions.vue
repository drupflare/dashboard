<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import { useDevicesStore } from '~/stores/devices';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Signed-In Devices' });

const session = useSessionStore();
const devices = useDevicesStore();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const waiting = ref<(() => Promise<void>) | null>(null);

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

const hasOthers = computed(() => (devices.items ?? []).some((device) => !device.current));

// a change that needs a fresh sign-in waits for the code, then runs
async function guarded(key: string, run: () => Promise<void>) {
	error.value = null;
	if (!fresh()) {
		waiting.value = () => guarded(key, run);
		return;
	}
	busy.value = key;
	try {
		await run();
	} catch (cause) {
		const apiError = toApiClientError(cause);
		const details = apiError.details as { requires?: string } | null;
		if (details?.requires === 'step-up') waiting.value = () => guarded(key, run);
		else error.value = apiError.message;
	} finally {
		busy.value = null;
	}
}

function signOutDevice(id: string) {
	return guarded(`device:${id}`, () => devices.revoke(id));
}

function signOutOthers() {
	return guarded('others', () => devices.revokeOthers());
}

async function resume() {
	const next = waiting.value;
	waiting.value = null;
	if (next) await next();
}

onMounted(() => devices.load());
</script>

<template>
	<ClientOnly>
		<div
			v-if="devices.items === undefined && !devices.error"
			role="status"
		>
			<span class="sr-only">Loading signed-in devices</span>
			<div
				aria-hidden="true"
				class="flex flex-col divide-y divide-default rounded-lg border border-default"
			>
				<div
					v-for="row in 2"
					:key="row"
					class="flex items-center justify-between gap-3 p-4"
				>
					<USkeleton class="h-5 w-40" />
					<USkeleton class="h-8 w-24" />
				</div>
			</div>
		</div>
		<div
			v-else
			class="flex max-w-3xl flex-col gap-6"
		>
			<UiPageHeader
				title="Signed-In Devices"
				text="Devices and browsers signed in to this account. Signing out a device ends its session there."
			/>

			<p
				v-if="devices.error"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ devices.error.message }}
			</p>
			<p
				v-if="error"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ error }}
			</p>

			<AccountStepUp
				v-if="waiting"
				@done="resume"
				@cancel="waiting = null"
			/>

			<UiEmptyState
				v-if="devices.items?.length === 0"
				icon="i-lucide-monitor-smartphone"
				title="No Signed-In Devices"
				text="Sign in again to see the devices on this account."
			/>
			<AccountSessionList
				v-else-if="devices.items"
				:items="devices.items"
				:busy="busy"
				@revoke="signOutDevice"
			/>

			<div v-if="hasOthers">
				<UButton
					color="neutral"
					variant="outline"
					icon="i-lucide-log-out"
					:loading="busy === 'others'"
					@click="signOutOthers"
				>
					Sign Out Everywhere Else
				</UButton>
			</div>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full max-w-3xl" />
		</template>
	</ClientOnly>
</template>
