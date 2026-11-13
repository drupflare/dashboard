<script setup lang="ts">
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { nameProblem } from '~/composables/useOnboarding';
import { linkStateOf } from '~/shared/nodes';
import { useNodesStore } from '~/stores/nodes';

definePageMeta({ middleware: ['auth', 'org'] });
useHead({ title: 'Create a Site on Your Box' });

const org = useOrgStore();
const router = useRouter();
const nodes = useNodesStore();

const orgId = computed(() => org.current?.id ?? null);
const list = computed(() => (orgId.value === null ? undefined : nodes.listFor(orgId.value)));
const now = ref(Date.now());
const selected = ref<string | null>(null);
const name = ref('');
const host = ref('');
const touched = ref(false);
const creating = ref(false);
const error = ref<ApiClientError | null>(null);
// one key per form, so a second click or a retry after a lost response is the same request
const key = ref(crypto.randomUUID());

const active = computed(() => (list.value?.items ?? []).filter((node) => node.state === 'active'));
const anyConnected = computed(() =>
	active.value.some((node) => linkStateOf(node, now.value) === 'connected')
);
const problem = computed(() => nameProblem(name.value));
const hostMissing = computed(() => host.value.trim() === '');
const ready = computed(
	() => selected.value !== null && problem.value === null && !hostMissing.value
);

async function submit(): Promise<void> {
	touched.value = true;
	if (creating.value || !ready.value || orgId.value === null || selected.value === null) return;
	creating.value = true;
	error.value = null;
	try {
		const operation = await nodes.createSite(
			orgId.value,
			selected.value,
			{ kind: 'drupal', name: name.value.trim(), host: host.value.trim() },
			key.value
		);
		await router.push(`/new/progress/${operation.id}`);
	} catch (cause) {
		error.value = toApiClientError(cause);
		key.value = crypto.randomUUID();
	} finally {
		creating.value = false;
	}
}

onMounted(() => {
	now.value = Date.now();
	if (orgId.value !== null) void nodes.reload(orgId.value);
});
watch(orgId, (id) => {
	if (id !== null) void nodes.reload(id);
});
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-2xl flex-col gap-6">
			<UiPageHeader
				title="Create a Site on Your Box"
				text="Drupflare asks the box to add the site. The box can hold the request until someone there approves it."
			/>

			<div
				v-if="list === undefined || list.status === 'loading'"
				role="status"
			>
				<span class="sr-only">Loading your boxes</span>
				<USkeleton class="h-24 w-full" />
			</div>
			<UiErrorState
				v-else-if="list.status === 'error' && list.error !== null"
				title="Could Not Load Your Boxes"
				:text="list.error.message"
				:request-id="list.error.requestId"
			/>
			<section
				v-else-if="active.length === 0"
				class="flex flex-col gap-3 rounded-lg border border-default p-6"
			>
				<p class="text-sm text-default">You have no paired box yet.</p>
				<div>
					<UButton
						to="/planes"
						color="primary"
						>Pair a Box</UButton
					>
				</div>
			</section>
			<form
				v-else
				class="flex flex-col gap-6 rounded-lg border border-default p-6"
				@submit.prevent="submit"
			>
				<OnboardingSelfhostedPicker
					v-model="selected"
					:nodes="active"
					:now="now"
				/>
				<p
					v-if="!anyConnected"
					class="text-sm text-muted"
				>
					No box is connected right now, so a site cannot be added yet.
				</p>
				<p
					v-if="touched && selected === null"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					Choose a connected box.
				</p>

				<UiField
					id="site-name"
					label="Site Name"
					:error="touched ? problem : null"
				>
					<template #default="{ describedBy }">
						<input
							id="site-name"
							v-model="name"
							type="text"
							autocomplete="off"
							spellcheck="false"
							:aria-describedby="describedBy"
							:aria-invalid="touched && problem ? 'true' : undefined"
							class="w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
							@blur="touched = true"
						/>
					</template>
				</UiField>

				<UiField
					id="site-host"
					label="Host Name"
					hint="The address the site answers on, such as www.example.org."
					:error="touched && hostMissing ? 'Enter a host name.' : null"
				>
					<template #default="{ describedBy }">
						<input
							id="site-host"
							v-model="host"
							type="text"
							autocomplete="off"
							spellcheck="false"
							inputmode="url"
							:aria-describedby="describedBy"
							:aria-invalid="touched && hostMissing ? 'true' : undefined"
							class="w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
							@blur="touched = true"
						/>
					</template>
				</UiField>

				<p
					v-if="error"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ error.message }}
				</p>

				<div class="flex flex-wrap justify-between gap-3">
					<UButton
						to="/new"
						color="neutral"
						variant="outline"
						>Back</UButton
					>
					<UButton
						type="submit"
						color="primary"
						variant="solid"
						:loading="creating"
						:disabled="creating"
						>Create</UButton
					>
				</div>
			</form>
		</div>
	</ClientOnly>
</template>
