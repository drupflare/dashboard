<script setup lang="ts">
import type { PickerSite } from '~/components/release/cohort/Picker.vue';
import { toApiClientError, useApi } from '~/composables/useApi';
import { useReleasesStore, type ReleaseView, type RolloutChoices } from '~/stores/releases';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Releases' });

const session = useSessionStore();
const releases = useReleasesStore();

const isAdmin = computed(() => session.me?.platformRole === 'admin');
const list = computed(() => releases.releases ?? []);
const anyRunning = computed(() => list.value.some((entry) => entry.rollout?.status === 'rolling'));

onMounted(() => void releases.load());

// a running rollout moves on its own, so the screen asks again while one runs
let timer: ReturnType<typeof setInterval> | null = null;
watch(anyRunning, (running) => {
	if (timer !== null) clearInterval(timer);
	timer = running ? setInterval(() => void releases.load(), 15_000) : null;
});
onBeforeUnmount(() => {
	if (timer !== null) clearInterval(timer);
});

// #region roll out

const target = ref<ReleaseView | null>(null);
const open = ref(false);
const sites = ref<PickerSite[]>([]);
const choices = ref<RolloutChoices>({
	designations: { synthetic: [], own: [], canary: [] },
	overrides: []
});
const busy = ref(false);
const error = ref<string | null>(null);
const needsStepUp = ref(false);
let key = '';

const fresh = () => {
	const until = session.me?.stepUpUntil;
	return until != null && Date.parse(until) > Date.now();
};

async function show(release: ReleaseView): Promise<void> {
	target.value = release;
	error.value = null;
	needsStepUp.value = false;
	key = crypto.randomUUID();
	choices.value = { designations: { synthetic: [], own: [], canary: [] }, overrides: [] };
	open.value = true;
	try {
		const page = await useApi().get<{ items: PickerSite[] }>('/admin/sites', { limit: '100' });
		sites.value = page.items;
	} catch {
		sites.value = [];
	}
}

async function rollOut(): Promise<void> {
	if (target.value === null) return;
	error.value = null;
	if (!fresh()) {
		needsStepUp.value = true;
		return;
	}
	busy.value = true;
	try {
		await releases.startRollout(target.value.id, choices.value, key);
		open.value = false;
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
	void rollOut();
}

// #endregion

const stopError = ref<string | null>(null);
async function stop(release: ReleaseView): Promise<void> {
	if (release.rollout === null) return;
	stopError.value = null;
	try {
		await releases.stopRollout(release.id, release.rollout.id);
	} catch (cause) {
		stopError.value = toApiClientError(cause).message;
	}
}

// #region register

const registering = ref(false);
const form = ref({
	kind: 'worker' as ReleaseView['kind'],
	version: '',
	manifestUrl: '',
	manifestDigest: ''
});
const registerError = ref<string | null>(null);
const registerBusy = ref(false);

async function register(): Promise<void> {
	registerError.value = null;
	registerBusy.value = true;
	try {
		await releases.register({ ...form.value });
		registering.value = false;
		form.value = { kind: 'worker', version: '', manifestUrl: '', manifestDigest: '' };
	} catch (cause) {
		registerError.value = toApiClientError(cause).message;
	} finally {
		registerBusy.value = false;
	}
}

// #endregion

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
</script>

<template>
	<ClientOnly>
		<UiEmptyState
			v-if="session.me !== undefined && !isAdmin"
			icon="i-lucide-file-question"
			title="Page Not Found"
			text="There is nothing at this address."
		/>
		<div
			v-else
			class="flex flex-col gap-6"
		>
			<UiPageHeader
				title="Releases"
				text="Roll a release out to the fleet one ring at a time. A bad reading stops the rollout."
			>
				<UButton
					icon="i-lucide-plus"
					color="neutral"
					variant="outline"
					@click="registering = true"
					>Register a Release</UButton
				>
			</UiPageHeader>

			<p
				v-if="stopError"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ stopError }}
			</p>

			<UiSkeletonTable
				v-if="releases.status === 'loading' && releases.releases === undefined"
				label="Loading releases"
				:rows="3"
				:columns="3"
			/>
			<UiErrorState
				v-else-if="releases.status === 'error' && releases.releases === undefined"
				title="Releases Could Not Load"
				:text="releases.error?.message"
				:request-id="releases.error?.requestId"
			>
				<UButton
					color="neutral"
					variant="outline"
					@click="releases.load()"
					>Try Again</UButton
				>
			</UiErrorState>
			<UiEmptyState
				v-else-if="list.length === 0"
				icon="i-lucide-package"
				title="No Releases Yet"
				text="A release shows up here when its publisher sends it, or when you register it from a manifest address."
			/>
			<div
				v-else
				class="flex flex-col gap-4"
			>
				<ReleaseCard
					v-for="release in list"
					:key="release.id"
					:release="release"
					:busy="busy"
					@roll-out="show"
					@stop="stop"
				/>
			</div>
		</div>
		<template #fallback>
			<UiSkeletonTable
				label="Loading releases"
				:rows="3"
				:columns="3"
			/>
		</template>

		<UModal
			v-model:open="open"
			:title="`Roll Out Release ${target?.version ?? ''}`"
			description="The release goes to every live site, one ring at a time."
		>
			<template #body>
				<div class="flex flex-col gap-4">
					<ReleaseCohortPicker
						v-model="choices"
						:sites="sites"
					/>
					<p
						v-if="error"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ error }}
					</p>
					<UiConfirmTyped
						:expected="target?.version ?? ''"
						label="Release Version"
						action="Roll Out"
						:busy="busy"
						@confirm="rollOut()"
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

		<UModal
			v-model:open="registering"
			title="Register a Release"
			description="The dashboard fetches the manifest, checks it against the digest, and stores the release."
		>
			<template #body>
				<form
					class="flex flex-col gap-4"
					@submit.prevent="register()"
				>
					<UiField
						id="release-version"
						label="Version"
						v-slot="{ describedBy }"
					>
						<input
							id="release-version"
							v-model="form.version"
							type="text"
							required
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<UiField
						id="release-url"
						label="Manifest Address"
						v-slot="{ describedBy }"
					>
						<input
							id="release-url"
							v-model="form.manifestUrl"
							type="url"
							required
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<UiField
						id="release-digest"
						label="Manifest Digest"
						hint="The sha256 digest the publisher gave, starting with sha256:"
						v-slot="{ describedBy }"
					>
						<input
							id="release-digest"
							v-model="form.manifestDigest"
							type="text"
							required
							:class="inputClass"
							:aria-describedby="describedBy"
						/>
					</UiField>
					<p
						v-if="registerError"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ registerError }}
					</p>
					<div class="flex gap-3">
						<UButton
							type="submit"
							:loading="registerBusy"
							:disabled="registerBusy"
							>Register</UButton
						>
						<UButton
							type="button"
							color="neutral"
							variant="outline"
							@click="registering = false"
							>Cancel</UButton
						>
					</div>
				</form>
			</template>
		</UModal>
	</ClientOnly>
</template>
