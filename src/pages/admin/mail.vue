<script setup lang="ts">
import { adminGet } from '~/composables/useAdminApi';
import { toApiClientError } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Mail' });

interface MailView {
	essential: string[];
	optional: string[];
	notificationsPaused: boolean;
	today: { sent: number; failed: number; skippedPaused: number; skippedPreference: number };
	dailyCap: number;
}

const session = useSessionStore();
const data = ref<MailView | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

async function load(): Promise<void> {
	status.value = 'loading';
	try {
		data.value = await adminGet<MailView>('/admin/mail');
		status.value = 'ready';
	} catch (cause) {
		error.value = toApiClientError(cause).message;
		status.value = 'error';
	}
}

onMounted(() => void load());
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
		class="flex flex-col gap-6"
	>
		<UiPageHeader
			title="Mail"
			text="Which categories are essential and which are optional, and whether optional mail is paused."
		/>
		<UiErrorState
			v-if="status === 'error'"
			title="Mail Could Not Load"
			:text="error"
		>
			<UButton
				color="neutral"
				variant="outline"
				@click="load()"
				>Try Again</UButton
			>
		</UiErrorState>
		<p
			v-else-if="status === 'loading' || data === null"
			role="status"
			class="text-sm text-muted"
		>
			Loading the mail categories
		</p>
		<template v-else>
			<p class="text-sm">
				Optional mail is
				<strong class="text-highlighted">{{
					data.notificationsPaused ? 'paused' : 'on'
				}}</strong>
				by the platform. Essential mail is never paused.
			</p>
			<section class="flex max-w-xl flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Essential Categories</h2>
				<ul class="flex flex-col gap-1 text-sm text-muted">
					<li
						v-for="category in data.essential"
						:key="category"
					>
						{{ category }}
					</li>
				</ul>
			</section>
			<section class="flex max-w-xl flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Optional Categories</h2>
				<ul class="flex flex-col gap-1 text-sm text-muted">
					<li
						v-for="category in data.optional"
						:key="category"
					>
						{{ category }}
					</li>
				</ul>
			</section>
			<section class="flex max-w-xl flex-col gap-2">
				<h2 class="text-lg font-semibold text-highlighted">Sending</h2>
				<p class="text-sm text-muted">
					Today (UTC): {{ data.today.sent }} of {{ data.dailyCap }} sent,
					{{ data.today.failed }} failed, {{ data.today.skippedPaused }} held while
					optional mail was paused, {{ data.today.skippedPreference }} skipped because the
					person had not opted in.
				</p>
			</section>
		</template>
	</div>
</template>
