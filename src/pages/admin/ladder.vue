<script setup lang="ts">
import Catalogue from '~/components/admin/ladder/Catalogue.vue';
import Switch from '~/components/admin/ladder/Switch.vue';
import { toApiClientError } from '~/composables/useApi';
import { useAdminLadderStore, type LadderScope } from '~/stores/admin-ladder';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });

const session = useSessionStore();
const store = useAdminLadderStore();
const saving = ref(false);
const saveError = ref<string | null>(null);

async function save(input: {
	scope: LadderScope;
	scopeId: string;
	auto: boolean;
	confirmation?: string;
}): Promise<void> {
	saving.value = true;
	saveError.value = null;
	try {
		await store.setSwitch(input.scope, input.scopeId, input.auto, input.confirmation);
	} catch (failure) {
		saveError.value = toApiClientError(failure).message;
	} finally {
		saving.value = false;
	}
}

onMounted(() => {
	void store.load();
});

useHead({ title: 'Repair Ladder' });
</script>

<template>
	<UiEmptyState
		v-if="session.me !== undefined && session.me?.platformRole !== 'admin'"
		icon="i-lucide-file-question"
		title="Page Not Found"
		text="There is nothing at this address."
	/>
	<div
		v-else
		class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6"
	>
		<header>
			<h1 class="text-2xl font-bold">Repair Ladder</h1>
			<p class="text-sm text-muted">
				Every repair the platform knows, which ones can run today, and the switches that
				turn automatic repair off.
			</p>
		</header>
		<UAlert
			v-if="store.status === 'error'"
			color="error"
			variant="subtle"
			title="The Ladder Could Not Be Loaded"
			:description="store.error?.message ?? 'Try again in a few minutes.'"
		/>
		<p
			v-else-if="store.status === 'loading' || store.status === 'idle'"
			role="status"
			class="text-sm text-muted"
		>
			Loading the ladder
		</p>
		<template v-else>
			<Catalogue :rows="store.rows" />
			<Switch
				:switches="store.switches"
				:busy="saving"
				:error="saveError"
				@save="save"
			/>
		</template>
	</div>
</template>
