<script setup lang="ts">
definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Account' });

const session = useSessionStore();
const colorMode = useColorMode();
const route = useRoute();
const signingOut = ref(false);
const connected = computed(() =>
	typeof route.query.connected === 'string' ? route.query.connected : undefined
);

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

const securityLinks = [
	{
		to: '/account/security',
		label: 'Passkeys',
		hint: 'Sign in with this device instead of a code.',
		icon: 'i-lucide-key-round'
	},
	{
		to: '/account/sessions',
		label: 'Devices',
		hint: 'See where you are signed in and sign out of the rest.',
		icon: 'i-lucide-monitor-smartphone'
	}
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
		<AccountSkeleton v-if="session.me === undefined" />
		<UiEmptyState
			v-else-if="session.me === null"
			icon="i-lucide-log-in"
			title="You Are Signed Out"
			text="Sign in to see your account."
		>
			<UButton to="/login">Sign In</UButton>
		</UiEmptyState>
		<div
			v-else
			class="flex max-w-3xl flex-col gap-10"
		>
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

			<AccountConnections :just-connected="connected" />

			<section class="flex flex-col gap-4">
				<h2 class="text-lg font-semibold text-highlighted">Security</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<NuxtLink
						v-for="link in securityLinks"
						:key="link.to"
						:to="link.to"
						class="flex items-start gap-3 rounded-lg border border-default p-4 hover:bg-muted"
					>
						<UIcon
							:name="link.icon"
							class="mt-0.5 size-4"
							aria-hidden="true"
						/>
						<span class="flex flex-col gap-1">
							<span class="font-medium text-highlighted">{{ link.label }}</span>
							<span class="text-sm text-muted">{{ link.hint }}</span>
						</span>
					</NuxtLink>
				</div>
			</section>

			<section class="flex flex-col gap-4">
				<h2 class="text-lg font-semibold text-highlighted">Sign-In</h2>
				<p class="max-w-prose text-muted">
					Sign-in codes go to {{ session.me?.email }}. Signing out ends the session on
					this device.
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
			<AccountSkeleton />
		</template>
	</ClientOnly>
</template>
