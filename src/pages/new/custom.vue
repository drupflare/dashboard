<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { nameProblem } from '~/composables/useOnboarding';
import { ARCHIVE_REASON_COPY } from '~/shared/custom-findings';
import { suggest } from '~/shared/names';
import type { Finding } from '~/shared/recipes';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Upload Your Own Worker' });

interface Intake {
	bundleId: string | null;
	sha256: string;
	fileName: string;
	deployable: boolean;
	findings: Finding[];
}

const org = useOrgStore();
const router = useRouter();
const orgId = computed(() => org.current?.id ?? null);

const uploading = ref(false);
const intake = ref<Intake | null>(null);
const uploadError = ref<string | null>(null);
const upgradeFor = ref<{ name: string } | null>(null);
const needsUpgrade = ref(false);

const name = ref('');
const touched = ref(false);
const creating = ref(false);
const createError = ref<ApiClientError | null>(null);
const problem = computed(() => nameProblem(name.value));
const nameError = computed(() => (touched.value ? problem.value : null));
const idempotencyKey = ref('');

function refusalText(error: ApiClientError): string {
	const reason = (error.details as { reason?: string } | null)?.reason;
	return (reason !== undefined && ARCHIVE_REASON_COPY[reason]) || error.message;
}

async function onFile(event: Event): Promise<void> {
	const file = (event.target as HTMLInputElement).files?.[0];
	if (file === undefined || orgId.value === null || uploading.value) return;
	uploading.value = true;
	intake.value = null;
	uploadError.value = null;
	needsUpgrade.value = false;
	upgradeFor.value = null;
	try {
		intake.value = await (
			$fetch as unknown as (url: string, options: Record<string, unknown>) => Promise<Intake>
		)(`/api/v1/orgs/${encodeURIComponent(orgId.value)}/custom-bundles`, {
			method: 'POST',
			query: { fileName: file.name },
			headers: { 'Content-Type': 'application/gzip' },
			body: file
		});
		idempotencyKey.value = crypto.randomUUID();
	} catch (error) {
		const failure = toApiClientError(error);
		if (failure.status === 401) useSessionStore().clear();
		const details = failure.details as {
			feature?: string;
			unlockedBy?: { name: string } | null;
		};
		if (failure.code === 'forbidden' && details?.feature === 'customCode') {
			needsUpgrade.value = true;
			upgradeFor.value = details.unlockedBy ?? null;
		} else {
			uploadError.value = refusalText(failure);
		}
	} finally {
		uploading.value = false;
	}
}

async function submit(): Promise<void> {
	touched.value = true;
	const bundleId = intake.value?.bundleId ?? null;
	if (creating.value || problem.value !== null || orgId.value === null || bundleId === null)
		return;
	creating.value = true;
	createError.value = null;
	try {
		const operation = await (
			$fetch as unknown as (
				url: string,
				options: Record<string, unknown>
			) => Promise<{ id: string }>
		)(`/api/v1/orgs/${encodeURIComponent(orgId.value)}/sites`, {
			method: 'POST',
			headers: { 'Idempotency-Key': idempotencyKey.value },
			body: { kind: 'custom', name: name.value, bundleId }
		});
		await router.push(`/new/progress/${operation.id}`);
	} catch (error) {
		createError.value = toApiClientError(error);
	} finally {
		creating.value = false;
	}
}

watch(orgId, (id) => {
	if (id !== null) void org.loadPlan(id);
});

onMounted(() => {
	const seed = crypto.randomUUID();
	name.value = suggest(seed);
	idempotencyKey.value = crypto.randomUUID();
	if (orgId.value !== null) void org.loadPlan(orgId.value);
});
</script>

<template>
	<div class="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
		<header class="flex flex-col gap-2">
			<h1 class="text-2xl font-semibold text-highlighted">Upload Your Own Worker</h1>
			<p class="text-sm text-muted">
				Upload a built Worker as a .tar.gz with a wrangler.jsonc at its top level. We read
				the bundle and never run it.
			</p>
		</header>

		<section class="flex flex-col gap-3">
			<label
				for="bundle-file"
				class="text-sm font-medium text-default"
			>
				Bundle File
			</label>
			<input
				id="bundle-file"
				type="file"
				accept=".gz,.tgz,.tar.gz,application/gzip"
				:disabled="uploading"
				class="text-sm text-default"
				@change="onFile"
			/>
			<p
				v-if="uploading"
				role="status"
				class="text-sm text-muted"
			>
				Reading the bundle
			</p>
			<p
				v-if="uploadError"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ uploadError }}
			</p>
		</section>

		<OnboardingCustomUpgrade
			v-if="needsUpgrade"
			:plan-name="upgradeFor?.name ?? null"
		/>

		<template v-if="intake">
			<OnboardingCustomFindings
				:findings="intake.findings"
				:deployable="intake.deployable"
			/>

			<form
				v-if="intake.deployable"
				class="flex flex-col gap-6"
				@submit.prevent="submit"
			>
				<OnboardingNameField
					v-model="name"
					:error="nameError"
					@blur="touched = true"
				/>
				<p
					v-if="createError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ createError.message }}
				</p>
				<div class="flex justify-end">
					<UButton
						type="submit"
						color="primary"
						variant="solid"
						:loading="creating"
						:disabled="creating"
					>
						Create
					</UButton>
				</div>
			</form>
		</template>
	</div>
</template>
