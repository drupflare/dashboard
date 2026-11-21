<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{ error: NuxtError }>();

const notFound = computed(() => props.error.statusCode === 404);

useHead({ title: computed(() => (notFound.value ? 'Page Not Found' : 'Something Went Wrong')) });
</script>

<template>
	<NuxtLayout name="public">
		<UiEmptyState
			v-if="notFound"
			icon="i-lucide-file-question"
			title="Page Not Found"
			text="That page doesn't exist."
		>
			<UButton
				color="neutral"
				to="/"
			>
				Go Home
			</UButton>
		</UiEmptyState>
		<UiEmptyState
			v-else
			icon="i-lucide-triangle-alert"
			title="Something Went Wrong"
			text="This page could not be shown. Go home and try again."
		>
			<UButton
				color="neutral"
				to="/"
			>
				Go Home
			</UButton>
		</UiEmptyState>
	</NuxtLayout>
</template>
