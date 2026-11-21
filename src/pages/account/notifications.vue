<script setup lang="ts">
import type { OptionalCategory } from '~/shared/notifications';
import { useNotificationPreferencesStore } from '~/stores/notification-preferences';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Notifications' });

const preferences = useNotificationPreferencesStore();
const busy = ref<OptionalCategory | null>(null);

onMounted(() => preferences.load());

async function toggle(category: OptionalCategory, enabled: boolean) {
	busy.value = category;
	await preferences.set(category, enabled);
	busy.value = null;
}
</script>

<template>
	<ClientOnly>
		<div
			v-if="preferences.current === undefined && !preferences.error"
			role="status"
		>
			<span class="sr-only">Loading notification settings</span>
			<USkeleton class="h-40 w-full max-w-3xl" />
		</div>
		<div
			v-else
			class="flex max-w-3xl flex-col gap-6"
		>
			<UiPageHeader
				title="Notifications"
				text="Choose which optional emails you get. Each one is off until you turn it on."
			/>

			<UiErrorState
				v-if="preferences.error && !preferences.current"
				title="Could Not Load Notifications"
				:text="preferences.error.message"
				:request-id="preferences.error.requestId"
			>
				<UButton
					color="neutral"
					@click="preferences.load(true)"
					>Try Again</UButton
				>
			</UiErrorState>

			<template v-else-if="preferences.current">
				<p
					v-if="preferences.saveError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ preferences.saveError.message }}
				</p>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Optional Emails</h2>
					<ul
						class="flex flex-col divide-y divide-default rounded-lg border border-default"
					>
						<li
							v-for="item in preferences.current.switches"
							:key="item.category"
							class="flex items-start justify-between gap-4 p-4"
						>
							<div class="flex flex-col gap-1">
								<span
									:id="`label-${item.category}`"
									class="text-sm font-medium text-highlighted"
									>{{ item.label }}</span
								>
								<span class="text-sm text-muted">{{ item.description }}</span>
							</div>
							<span
								v-if="!item.available"
								class="shrink-0 text-sm text-muted"
								>Not available yet</span
							>
							<input
								v-else
								type="checkbox"
								role="switch"
								class="mt-1 size-5 shrink-0"
								:aria-labelledby="`label-${item.category}`"
								:checked="item.enabled"
								:disabled="busy === item.category"
								@change="
									toggle(
										item.category,
										($event.target as HTMLInputElement).checked
									)
								"
							/>
						</li>
					</ul>
				</section>

				<section class="flex flex-col gap-3">
					<h2 class="text-lg font-semibold text-highlighted">Emails That Always Send</h2>
					<p class="text-sm text-muted">
						These keep your account working or safe, so they have no switch.
					</p>
					<ul
						class="flex flex-col divide-y divide-default rounded-lg border border-default"
					>
						<li
							v-for="item in preferences.current.essential"
							:key="item.label"
							class="flex items-start justify-between gap-4 p-4"
						>
							<div class="flex flex-col gap-1">
								<span class="text-sm font-medium text-highlighted">{{
									item.label
								}}</span>
								<span class="text-sm text-muted">{{ item.description }}</span>
							</div>
							<span class="shrink-0 text-sm text-muted">Always on</span>
						</li>
					</ul>
				</section>
			</template>
		</div>
		<template #fallback>
			<USkeleton class="h-40 w-full max-w-3xl" />
		</template>
	</ClientOnly>
</template>
