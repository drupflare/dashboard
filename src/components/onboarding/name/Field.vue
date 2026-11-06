<script setup lang="ts">
import { HOST_SUFFIX } from '~/composables/useOnboarding';

const name = defineModel<string>({ required: true });
defineProps<{ error: string | null }>();
const emit = defineEmits<{ blur: [] }>();
</script>

<template>
	<div class="flex flex-col gap-3">
		<UiField
			id="site-name"
			label="Site Name"
			hint="The suggestion is three random words. Change it if you like."
			:error="error"
		>
			<template #default="{ describedBy }">
				<input
					id="site-name"
					v-model="name"
					type="text"
					autocomplete="off"
					spellcheck="false"
					:aria-describedby="describedBy"
					:aria-invalid="error ? 'true' : undefined"
					class="w-full rounded-md border border-default bg-default px-3 py-2 text-default focus-visible:ring-2 focus-visible:ring-primary"
					@blur="emit('blur')"
				/>
			</template>
		</UiField>
		<p class="wrap-break-word text-sm text-muted">
			Address:
			<span class="font-medium text-default">{{ name }}.{{ HOST_SUFFIX }}</span>
		</p>
	</div>
</template>
