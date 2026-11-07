<script setup lang="ts">
definePageMeta({ layout: 'public' });
useSeoMeta({
	title: 'Drupflare: Drupal Without the Server',
	description:
		'Create a managed Drupal site on Cloudflare, watch every step of the build, and restore it from a backup.'
});

const session = useSessionStore();

onMounted(async () => {
	await session.ensure();
	if (session.me) await navigateTo('/sites');
});

const steps = [
	{
		title: 'Pick Drupal and a name',
		text: 'We suggest a three-word name for the address. You can change it before you create the site.'
	},
	{
		title: 'Watch it build',
		text: 'Every step shows its state as it runs. If one fails, the record says which step and why.'
	},
	{
		title: 'Sign in to the new site',
		text: 'The admin password appears once, on the screen where the site goes live. Copy it then.'
	}
];

const today = [
	{
		term: 'An address',
		text: 'A three-word name on drupflare.app, like quiet-otter-lamp.drupflare.app.'
	},
	{
		term: 'Backups',
		text: 'Back up a site, then restore the backup into a new site.'
	},
	{
		term: 'A record of every action',
		text: 'Creating and restoring a site are operations, and you can read each one step by step.'
	}
];
</script>

<template>
	<div>
		<section
			class="mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]"
		>
			<div class="flex flex-col items-start gap-6">
				<p class="text-sm font-medium text-muted">Managed Drupal on Cloudflare</p>
				<h1 class="text-4xl font-bold text-balance text-highlighted sm:text-6xl">
					Drupal Without the Server
				</h1>
				<p class="max-w-xl text-lg text-muted">
					Create a Drupal site, get an address, and start building. There is no server to
					patch and no hosting plan to size.
				</p>
				<div class="flex flex-wrap items-center gap-3">
					<UButton
						to="/login"
						size="xl"
						>Create a Site</UButton
					>
					<UButton
						to="/#how"
						size="xl"
						color="neutral"
						variant="ghost"
						>See How It Works</UButton
					>
				</div>
				<p class="text-sm text-muted">
					Sign in with a code we email you. Sites start on a free drupflare.app address.
				</p>
			</div>
			<LandingSteps />
		</section>

		<section
			id="how"
			class="border-t border-default"
		>
			<div class="mx-auto grid max-w-6xl gap-8 px-4 py-14 lg:grid-cols-[1fr_2fr]">
				<h2 class="text-2xl font-bold text-highlighted sm:text-3xl">How It Works</h2>
				<ol class="flex flex-col gap-8">
					<li
						v-for="(step, index) in steps"
						:key="step.title"
						class="grid grid-cols-[2.5rem_1fr] gap-x-4"
					>
						<span
							class="font-display text-3xl font-bold text-muted"
							aria-hidden="true"
							>{{ index + 1 }}</span
						>
						<div>
							<h3 class="text-lg font-semibold text-highlighted">{{ step.title }}</h3>
							<p class="mt-1 max-w-prose text-muted">{{ step.text }}</p>
						</div>
					</li>
				</ol>
			</div>
		</section>

		<section class="border-t border-default bg-muted">
			<div class="mx-auto grid max-w-6xl gap-8 px-4 py-14 lg:grid-cols-[1fr_2fr]">
				<h2 class="text-2xl font-bold text-highlighted sm:text-3xl">What You Get Today</h2>
				<dl class="flex flex-col divide-y divide-default">
					<div
						v-for="item in today"
						:key="item.term"
						class="grid gap-1 py-4 first:pt-0 sm:grid-cols-[12rem_1fr] sm:gap-6"
					>
						<dt class="font-semibold text-highlighted">{{ item.term }}</dt>
						<dd class="text-muted">{{ item.text }}</dd>
					</div>
				</dl>
			</div>
		</section>

		<section class="border-t border-default">
			<div class="mx-auto grid max-w-6xl gap-8 px-4 py-14 lg:grid-cols-[1fr_2fr]">
				<h2 class="text-2xl font-bold text-highlighted sm:text-3xl">Not Built Yet</h2>
				<div class="flex max-w-prose flex-col items-start gap-6">
					<p class="text-muted">
						Importing an existing site from a server, custom domains, health warnings,
						WordPress and Joomla are planned. They are not in this release, so the
						dashboard does not offer them.
					</p>
					<UButton
						to="/login"
						size="lg"
						>Create a Site</UButton
					>
				</div>
			</div>
		</section>
	</div>
</template>
