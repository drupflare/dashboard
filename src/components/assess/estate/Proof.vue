<script setup lang="ts">
import type { ProofCheck, ProofView } from '~/shared/estate-view';

defineProps<{
	view: ProofView | null;
	loading: boolean;
	error: string | null;
	check: ProofCheck | null;
	checking: boolean;
	checkError: string | null;
}>();
const emit = defineEmits<{ check: [] }>();

const method = defineModel<'dns' | 'http'>('method', { required: true });
</script>

<template>
	<section class="flex flex-col gap-5 rounded-lg border border-default p-6">
		<h3 class="text-base font-semibold text-highlighted">Domain Proof</h3>

		<p
			v-if="loading"
			role="status"
			class="text-sm text-muted"
		>
			Loading the proof.
		</p>

		<p
			v-if="error"
			role="alert"
			class="text-sm text-red-700 dark:text-red-400"
		>
			{{ error }}
		</p>

		<template v-if="view">
			<p class="text-sm text-default">
				This proves you control {{ view.domain }}. It covers every site on that domain.
			</p>
			<p
				v-if="view.proven"
				class="text-sm text-default"
			>
				This domain is already proven.
			</p>

			<div class="flex flex-col gap-2">
				<h4 class="text-sm font-semibold text-highlighted">DNS Record</h4>
				<p class="text-sm text-default">
					Add this TXT record to the DNS for {{ view.domain }}.
				</p>
				<dl class="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
					<dt class="text-muted">Type</dt>
					<dd class="font-mono text-highlighted">TXT</dd>
					<dt class="text-muted">Name</dt>
					<dd class="font-mono break-all text-highlighted select-all">
						{{ view.record.name }}
					</dd>
					<dt class="text-muted">Value</dt>
					<dd class="font-mono break-all text-highlighted select-all">
						{{ view.record.value }}
					</dd>
				</dl>
			</div>

			<div class="flex flex-col gap-2">
				<h4 class="text-sm font-semibold text-highlighted">File on the Site</h4>
				<p class="text-sm text-default">
					Or publish a file at https://{{ view.domain }}{{ view.file.path }} that holds
					only this text:
				</p>
				<code
					class="block rounded-md bg-elevated px-3 py-2 text-sm break-all text-highlighted select-all"
					>{{ view.file.content }}</code
				>
			</div>

			<div class="flex flex-col gap-4 border-t border-default pt-5">
				<label class="flex flex-col gap-1 text-sm font-medium text-default">
					Where to Look
					<select
						v-model="method"
						class="w-fit rounded-md border border-default bg-default px-3 py-2 font-normal text-default"
					>
						<option value="dns">DNS TXT Record</option>
						<option value="http">File on the Site</option>
					</select>
				</label>

				<div>
					<UButton
						color="primary"
						variant="solid"
						:loading="checking"
						:disabled="checking"
						@click="emit('check')"
					>
						Check Now
					</UButton>
				</div>

				<p
					v-if="checkError"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ checkError }}
				</p>

				<p
					v-if="check"
					role="status"
					class="text-sm text-default"
				>
					<template v-if="check.proven">
						Proven. {{ check.detail }} The sites on this domain stay at Needs Proof in
						this assessment. Start a new assessment to check them.
					</template>
					<template v-else>{{ check.detail }}</template>
				</p>
			</div>
		</template>
	</section>
</template>
