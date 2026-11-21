<script setup lang="ts">
import {
	DATA_LOCATION_STATEMENT,
	LIMITATIONS,
	SECURITY_PRACTICES,
	SUBPROCESSORS
} from '~/shared/trust';
import { useTrustStore } from '~/stores/trust';

definePageMeta({ layout: 'public' });
useSpool();
useSeoMeta({
	title: 'Trust Center',
	description:
		'The subprocessors, security practices, documented limitations and downloadable evidence for Drupflare.'
});

const trust = useTrustStore();

onMounted(() => {
	void trust.loadPublished();
});
</script>

<template>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-12 sm:px-6">
		<header class="flex flex-col gap-3">
			<h1 class="text-3xl font-bold text-highlighted">Trust Center</h1>
			<p class="text-default">
				Who processes your data, what we do to protect it, what Drupflare does not do yet,
				and the documents you can download for a review.
			</p>
		</header>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="subprocessors-heading"
		>
			<h2
				id="subprocessors-heading"
				class="text-xl font-semibold text-highlighted"
			>
				Subprocessors
			</h2>
			<p class="text-default">
				These are the third-party services that handle customer data for Drupflare.
			</p>
			<TrustSubprocessors :items="SUBPROCESSORS" />
		</section>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="practices-heading"
		>
			<h2
				id="practices-heading"
				class="text-xl font-semibold text-highlighted"
			>
				Security Practices
			</h2>
			<ul class="flex list-disc flex-col gap-2 pl-5 text-default">
				<li
					v-for="practice in SECURITY_PRACTICES"
					:key="practice"
				>
					{{ practice }}
				</li>
			</ul>
		</section>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="limitations-heading"
		>
			<h2
				id="limitations-heading"
				class="text-xl font-semibold text-highlighted"
			>
				Documented Limitations
			</h2>
			<ul class="flex list-disc flex-col gap-2 pl-5 text-default">
				<li
					v-for="limit in LIMITATIONS"
					:key="limit"
				>
					{{ limit }}
				</li>
			</ul>
		</section>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="location-heading"
		>
			<h2
				id="location-heading"
				class="text-xl font-semibold text-highlighted"
			>
				Data Location
			</h2>
			<p class="text-default">{{ DATA_LOCATION_STATEMENT }}</p>
		</section>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="evidence-heading"
		>
			<h2
				id="evidence-heading"
				class="text-xl font-semibold text-highlighted"
			>
				Downloadable Evidence
			</h2>
			<TrustDocuments
				:items="trust.published"
				:failed="trust.error !== null && trust.published === undefined"
			/>
		</section>
	</div>
</template>
