<script setup lang="ts">
definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Security' });
</script>

<template>
	<div class="flex max-w-3xl flex-col gap-10">
		<UiPageHeader
			title="Security"
			text="Passkeys sign you in without an email code. Each one lives on a device or in a password manager."
		/>

		<section class="flex flex-col gap-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 class="text-lg font-semibold text-highlighted">Passkeys</h2>
				<AccountPasskeyAdd />
			</div>
			<AccountPasskeyList />
		</section>
	</div>
</template>
