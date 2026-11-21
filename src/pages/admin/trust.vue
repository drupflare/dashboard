<script setup lang="ts">
import {
	TRUST_CONTENT_TYPES,
	TRUST_DOCUMENT_KIND_LABELS,
	TRUST_DOCUMENT_KINDS,
	TRUST_MAX_BYTES,
	type TrustContentType,
	type TrustDocumentKind
} from '~/shared/trust';
import { useTrustStore } from '~/stores/trust';

definePageMeta({ middleware: ['auth'] });
useHead({ title: 'Trust Center Documents' });

const trust = useTrustStore();

const inputClass =
	'w-full rounded-md border border-default bg-default px-3 py-2 text-default placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const contentTypeLabels: Record<TrustContentType, string> = {
	'application/pdf': 'PDF',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (DOCX)',
	'text/markdown': 'Markdown',
	'text/plain': 'Plain Text'
};

const form = reactive({
	title: '',
	kind: 'hecvat' as TrustDocumentKind,
	version: '',
	contentType: 'application/pdf' as TrustContentType,
	file: null as File | null
});
const localError = ref<string | null>(null);

onMounted(() => {
	void trust.loadAll();
});

async function toBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function onFile(event: Event) {
	const input = event.target as HTMLInputElement;
	form.file = input.files?.[0] ?? null;
}

async function upload() {
	localError.value = null;
	if (!form.file) {
		localError.value = 'Choose a file to upload.';
		return;
	}
	if (form.file.size > TRUST_MAX_BYTES) {
		localError.value = 'The file is larger than 10 MB.';
		return;
	}
	const ok = await trust.upload({
		title: form.title,
		kind: form.kind,
		version: form.version,
		contentType: form.contentType,
		contentBase64: await toBase64(form.file)
	});
	if (ok) {
		form.title = '';
		form.version = '';
		form.file = null;
	}
}

const state = computed(() => {
	if (trust.error && trust.documents === undefined) return 'error';
	if (trust.documents === undefined) return 'loading';
	if (trust.documents.length === 0) return 'empty';
	return 'list';
});
</script>

<template>
	<div class="flex flex-col gap-8">
		<UiPageHeader
			title="Trust Center Documents"
			text="Upload the evidence the trust center offers, then publish it. Each publish and retire is written to the platform audit log."
		/>

		<form
			class="flex flex-col gap-4 rounded-lg border border-default p-4 sm:max-w-2xl"
			@submit.prevent="upload"
		>
			<h2 class="text-lg font-semibold text-highlighted">Upload a Draft</h2>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">Title</span>
				<input
					v-model="form.title"
					:class="inputClass"
					maxlength="160"
					required
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">Kind</span>
				<select
					v-model="form.kind"
					:class="inputClass"
				>
					<option
						v-for="kind in TRUST_DOCUMENT_KINDS"
						:key="kind"
						:value="kind"
					>
						{{ TRUST_DOCUMENT_KIND_LABELS[kind] }}
					</option>
				</select>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">Version</span>
				<input
					v-model="form.version"
					:class="inputClass"
					maxlength="40"
					required
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">File Type</span>
				<select
					v-model="form.contentType"
					:class="inputClass"
				>
					<option
						v-for="(label, type) in contentTypeLabels"
						:key="type"
						:value="type"
					>
						{{ label }}
					</option>
				</select>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium text-highlighted">File</span>
				<input
					type="file"
					:accept="Object.keys(TRUST_CONTENT_TYPES).join(',')"
					class="text-sm text-default"
					@change="onFile"
				/>
				<span class="text-sm text-muted">Up to 10 MB.</span>
			</label>

			<p
				v-if="localError || trust.saveError"
				role="alert"
				class="text-sm text-error"
			>
				{{ localError ?? trust.saveError?.message }}
			</p>

			<UButton
				type="submit"
				:loading="trust.saving"
				class="self-start"
				>Upload Draft</UButton
			>
		</form>

		<section
			class="flex flex-col gap-4"
			aria-labelledby="documents-heading"
		>
			<h2
				id="documents-heading"
				class="text-lg font-semibold text-highlighted"
			>
				All Documents
			</h2>
			<p
				v-if="state === 'error'"
				role="alert"
				class="text-sm text-error"
			>
				{{ trust.error?.message }}
			</p>
			<p
				v-else-if="state === 'loading'"
				role="status"
				class="text-sm text-muted"
			>
				Loading documents
			</p>
			<p
				v-else-if="state === 'empty'"
				class="text-sm text-muted"
			>
				No documents yet. Upload a draft to start.
			</p>
			<ul
				v-else
				class="divide-y divide-default rounded-lg border border-default"
			>
				<li
					v-for="doc in trust.documents"
					:key="doc.id"
					class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="flex min-w-0 flex-col gap-1">
						<span class="font-medium text-highlighted">{{ doc.title }}</span>
						<span class="text-sm text-muted">
							{{ TRUST_DOCUMENT_KIND_LABELS[doc.kind] }}, version {{ doc.version }},
							{{
								doc.retiredAt ? 'retired' : doc.publishedAt ? 'published' : 'draft'
							}}
						</span>
						<code class="break-all text-xs text-dimmed">SHA-256 {{ doc.sha256 }}</code>
					</div>
					<div class="flex shrink-0 gap-2">
						<UButton
							v-if="!doc.publishedAt && !doc.retiredAt"
							color="primary"
							:loading="trust.saving"
							@click="trust.act(doc.id, 'publish')"
							>Publish {{ doc.title }}</UButton
						>
						<UButton
							v-else-if="doc.publishedAt && !doc.retiredAt"
							color="neutral"
							:loading="trust.saving"
							@click="trust.act(doc.id, 'retire')"
							>Retire {{ doc.title }}</UButton
						>
					</div>
				</li>
			</ul>
		</section>
	</div>
</template>
