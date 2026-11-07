<script setup lang="ts">
definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Account' });

const session = useSessionStore();
const colorMode = useColorMode();
const signingOut = ref(false);

const themes = [
	{
		value: 'system',
		label: 'System',
		hint: 'Follow the setting on this device.',
		icon: 'i-lucide-monitor'
	},
	{ value: 'light', label: 'Light', hint: 'Dark text on a white page.', icon: 'i-lucide-sun' },
	{ value: 'dark', label: 'Dark', hint: 'Light text on a black page.', icon: 'i-lucide-moon' }
] as const;

async function signOut() {
	signingOut.value = true;
	await session.signOut();
	signingOut.value = false;
	if (session.me === null) await navigateTo('/login');
}
</script>

<template>
	<ClientOnly>
		<div class="flex max-w-3xl flex-col gap-10">
			<UiPageHeader
				title="Account"
				:text="session.me?.email"
			/>

			<section class="flex flex-col gap-4">
				<h2 class="text-lg font-semibold text-highlighted">Appearance</h2>
				<fieldset class="grid gap-3 sm:grid-cols-3">
					<legend class="sr-only">Theme</legend>
					<label
						v-for="theme in themes"
						:key="theme.value"
						:for="`theme-${theme.value}`"
						class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-4 has-checked:border-brand-600 has-checked:bg-muted dark:has-checked:border-brand-400"
					>
						<input
							:id="`theme-${theme.value}`"
							v-model="colorMode.preference"
							type="radio"
							name="theme"
							:value="theme.value"
							class="mt-1 size-4 accent-primary"
						/>
						<span class="flex flex-col gap-1">
							<span
								class="inline-flex items-center gap-2 font-medium text-highlighted"
							>
								<UIcon
									:name="theme.icon"
									class="size-4"
									aria-hidden="true"
								/>
								{{ theme.label }}
							</span>
							<span class="text-sm text-muted">{{ theme.hint }}</span>
						</span>
					</label>
				</fieldset>
			</section>

			<section class="flex flex-col gap-4">
				<h2 class="text-lg font-semibold text-highlighted">Sign-In</h2>
				<p class="max-w-prose text-muted">
					You sign in with a code sent to {{ session.me?.email }}. Signing out ends this
					session on this device.
				</p>
				<div>
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-log-out"
						:loading="signingOut"
						@click="signOut"
					>
						Sign Out
					</UButton>
				</div>
			</section>
		</div>
		<template #fallback>
			<p
				role="status"
				class="text-sm text-muted"
			>
				Loading...
			</p>
		</template>
	</ClientOnly>
</template>
