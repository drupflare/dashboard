<script setup lang="ts">
definePageMeta({ layout: 'public' });
useSeoMeta({
	title: 'Move a Drupal Site to Drupflare',
	description:
		'What Drupflare moves today, what needs an upgrade first, what is not supported yet, and what the move does to your server.'
});

const sections = [
	{
		title: 'What Moves Today',
		text: 'Drupal 11 sites on a Linux server that Drupflare can reach over SSH, with a MySQL or MariaDB database. Drupflare reads the database and the public files and builds a new site from them.'
	},
	{
		title: 'What Needs an Upgrade First',
		text: 'Drupal 7 through 10. The upgrade comes before the move, and Drupflare does not run that upgrade yet. The report for these sites says which version it found.'
	},
	{
		title: 'What Is Not Yet Supported',
		text: 'WordPress and Joomla sites, databases other than MySQL and MariaDB, and sites that keep a private files folder. Sites larger than one restore can take are refused with the reason shown. None of these has a date yet.'
	},
	{
		title: 'What the Move Does to Your Server',
		text: 'Nothing. The survey and the copy only read. Drupflare deletes the connection key when the job ends. Your server keeps serving your visitors until you approve a cutover, and even then Drupflare never deletes the source.'
	},
	{
		title: 'What Carries Over',
		text: 'The database, which holds your content and users, and the public uploaded files. The report lists the modules your site enables and flags anything it found that a database copy does not carry, such as Redis data outside the cache.'
	},
	{
		title: 'What Does Not Carry Over',
		text: 'The private files folder, Drupal code that lives on your server, and anything stored outside the database and the public files. Check the report before you start.'
	}
];

const steps = [
	{
		title: 'Check Your Address',
		text: 'Enter your site address to see what it shows to any visitor. This needs no account.',
		to: '/migrate/preflight',
		action: 'Check a Site Address'
	},
	{
		title: 'Create an Account',
		text: 'Sign in with a code we email you. Then choose Import From a Server.',
		to: { path: '/login', query: { redirect: '/new/import' } },
		action: 'Create an Account'
	},
	{
		title: 'Connect Your Server',
		text: 'Add the server, confirm its host key, and read the report. Nothing starts until you approve it.',
		to: null,
		action: null
	}
];
</script>

<template>
	<div class="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-12">
		<header class="flex flex-col gap-4">
			<h1 class="text-3xl font-bold text-balance text-highlighted sm:text-5xl">
				Move a Drupal Site to Drupflare
			</h1>
			<p class="max-w-prose text-lg text-muted">
				Drupflare copies a Drupal site from your server into a new site on Cloudflare. Read
				what it supports today before you start.
			</p>
		</header>

		<dl class="flex flex-col divide-y divide-default">
			<div
				v-for="section in sections"
				:key="section.title"
				class="grid gap-1 py-5 first:pt-0 sm:grid-cols-[14rem_1fr] sm:gap-6"
			>
				<dt class="font-semibold text-highlighted">{{ section.title }}</dt>
				<dd class="max-w-prose text-muted">{{ section.text }}</dd>
			</div>
		</dl>

		<section aria-labelledby="next-steps">
			<h2
				id="next-steps"
				class="text-2xl font-bold text-highlighted"
			>
				Three Next Steps
			</h2>
			<ol class="mt-6 flex flex-col gap-6">
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
					<div class="flex flex-col items-start gap-2">
						<h3 class="text-lg font-semibold text-highlighted">{{ step.title }}</h3>
						<p class="max-w-prose text-muted">{{ step.text }}</p>
						<UButton
							v-if="step.to"
							:to="step.to"
							color="neutral"
							variant="outline"
							>{{ step.action }}</UButton
						>
					</div>
				</li>
			</ol>
		</section>
	</div>
</template>
