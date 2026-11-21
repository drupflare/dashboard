<script setup lang="ts">
import { TRUST_DOCUMENT_KIND_LABELS, type TrustDocumentView } from '~/shared/trust';

defineProps<{
	items: TrustDocumentView[] | undefined;
	failed: boolean;
}>();

const size = (bytes: number) =>
	bytes < 1024 * 1024
		? `${Math.ceil(bytes / 1024)} KB`
		: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US') : '');
const href = (id: string) => `/api/v1/trust/documents/${encodeURIComponent(id)}/download`;
</script>

<template>
	<div>
		<p
			v-if="failed"
			role="alert"
			class="text-sm text-error"
		>
			The documents could not be loaded. Reload the page to try again.
		</p>
		<p
			v-else-if="items === undefined"
			role="status"
			class="text-sm text-muted"
		>
			Loading documents
		</p>
		<p
			v-else-if="items.length === 0"
			class="text-sm text-muted"
		>
			No documents are published yet.
		</p>
		<ul
			v-else
			class="divide-y divide-default rounded-lg border border-default"
		>
			<li
				v-for="item in items"
				:key="item.id"
				class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
			>
				<div class="flex min-w-0 flex-col gap-1">
					<span class="font-medium text-highlighted">{{ item.title }}</span>
					<span class="text-sm text-muted">
						{{ TRUST_DOCUMENT_KIND_LABELS[item.kind] }}, version {{ item.version }},
						{{ size(item.sizeBytes) }}, published {{ date(item.publishedAt) }}
					</span>
					<code class="break-all text-xs text-dimmed">SHA-256 {{ item.sha256 }}</code>
				</div>
				<a
					:href="href(item.id)"
					class="shrink-0 text-sm font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
					>Download {{ item.title }}</a
				>
			</li>
		</ul>
	</div>
</template>
