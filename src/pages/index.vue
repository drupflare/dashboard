<script setup lang="ts">
definePageMeta({ layout: 'public' });
useSeoMeta({
	title: 'Drupflare: Managed Drupal Sites on Cloudflare',
	description:
		'Drupflare creates and hosts Drupal sites on Cloudflare, with an address on drupflare.app, backups you can restore and a record of every action.'
});

const steps = [
	{
		title: 'Pick Drupal and a Name',
		text: 'Drupflare suggests a name made of three words. Change it before you create the site.'
	},
	{
		title: 'Watch It Build',
		text: 'Each step shows its state as it runs. If a step fails, the record shows which one and why.'
	},
	{
		title: 'Sign In to the New Site',
		text: 'You can reveal the admin password once. Save it when you do.'
	}
];

const included = [
	{
		term: 'An Address',
		text: 'A three-word name on drupflare.app, like quiet-otter-lamp.drupflare.app.'
	},
	{
		term: 'Backups',
		text: 'Back up a site at any time. Restore a backup into another site in your organization, or download it as a SQL file.'
	},
	{
		term: 'A Record of Every Action',
		text: 'Creating, updating, backing up, restoring and deleting a site are each an operation, with every step listed.'
	}
];
</script>

<template>
	<div>
		<section
			class="mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]"
		>
			<div class="flex flex-col items-start gap-6">
				<h1 class="text-4xl font-bold text-balance text-highlighted sm:text-6xl">
					Managed Drupal Sites on Cloudflare
				</h1>
				<p class="max-w-xl text-lg text-muted">
					Drupflare creates and hosts Drupal sites on Cloudflare. It is for anyone who
					wants a Drupal site without running the hosting.
				</p>
				<div class="flex flex-wrap items-center gap-3">
					<UButton
						to="/new"
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
				<p class="text-sm text-muted">Sign in with a code we email you.</p>
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
				<h2 class="text-2xl font-bold text-highlighted sm:text-3xl">What You Get</h2>
				<dl class="flex flex-col divide-y divide-default">
					<div
						v-for="item in included"
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
				<h2 class="text-2xl font-bold text-highlighted sm:text-3xl">Get Started</h2>
				<div class="flex max-w-prose flex-col items-start gap-6">
					<p class="text-muted">
						Sign in with a code we email you, choose Drupal, and name your site.
					</p>
					<UButton
						to="/new"
						size="lg"
						>Create a Site</UButton
					>
				</div>
			</div>
		</section>
	</div>
</template>
