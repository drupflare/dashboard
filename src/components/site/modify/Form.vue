<script setup lang="ts">
import { toApiClientError } from '~/composables/useApi';
import {
	checkModifyFiles,
	MODIFY_NOTE_MAX,
	modifyNameProblem,
	modifyRequestProblem,
	modifyRoot,
	type ModifyKind,
	type ModifyProblem
} from '~/shared/modify';
import { useReleasesStore } from '~/stores/releases';

const props = defineProps<{ orgId: string; siteId: string }>();

interface Row {
	key: number;
	// the path inside the folder, without the module's own directory
	rest: string;
	content: string;
	pasted: boolean;
	// the bytes are not UTF-8 text, which the site cannot store
	binary: boolean;
}

const KINDS: { value: ModifyKind; label: string }[] = [
	{ value: 'module', label: 'Module' },
	{ value: 'theme', label: 'Theme' },
	{ value: 'profile', label: 'Profile' }
];

const releases = useReleasesStore();

const open = ref(false);
const kind = ref<ModifyKind>('module');
const name = ref('');
const rows = ref<Row[]>([]);
const note = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const serverProblems = ref<ModifyProblem[]>([]);
let counter = 0;
let request: Promise<void> | null = null;

const trimmedName = computed(() => name.value.trim());
const nameProblem = computed(() =>
	trimmedName.value === '' ? null : modifyNameProblem(trimmedName.value)
);
const noteProblem = computed(() =>
	note.value.trim().length > MODIFY_NOTE_MAX
		? `Keep the note to ${MODIFY_NOTE_MAX} characters.`
		: null
);

// binary rows are held back from the check and from the request
const sendable = computed(() => rows.value.filter((row) => !row.binary));
const files = computed(() =>
	sendable.value.map((row) => ({
		path: modifyRoot(kind.value, trimmedName.value) + row.rest.trim(),
		content: row.content
	}))
);
const checked = computed(() =>
	trimmedName.value === '' || nameProblem.value !== null ? null : checkModifyFiles(files.value)
);
const body = computed(() => ({ files: files.value, note: note.value.trim() }));
const requestProblem = computed(() =>
	checked.value?.ok === true ? modifyRequestProblem(body.value) : null
);

const problems = computed<ModifyProblem[]>(() => [
	...(checked.value !== null && !checked.value.ok ? checked.value.problems : []),
	...serverProblems.value
]);
const problemOf = (row: Row): string | null => {
	if (row.binary) {
		return 'This file is not text, and the site stores module files as text. Remove it.';
	}
	const index = sendable.value.indexOf(row);
	return problems.value.find((problem) => problem.file === index)?.message ?? null;
};
const setProblems = computed(() => problems.value.filter((problem) => problem.file === null));

const ready = computed(
	() =>
		trimmedName.value !== '' &&
		nameProblem.value === null &&
		note.value.trim() !== '' &&
		noteProblem.value === null &&
		rows.value.length > 0 &&
		rows.value.every((row) => !row.binary) &&
		checked.value?.ok === true &&
		requestProblem.value === null
);

const sizeOf = (row: Row) => new TextEncoder().encode(row.content).length;

async function pick(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	const picked: Row[] = [];
	for (const file of Array.from(input.files ?? [])) {
		const parts = (file.webkitRelativePath || file.name).split('/');
		if (trimmedName.value === '' && file.webkitRelativePath !== '' && parts.length > 1) {
			name.value = parts[0] ?? '';
		}
		let content = '';
		let binary = false;
		try {
			content = decoder.decode(await file.arrayBuffer());
		} catch {
			binary = true;
		}
		picked.push({
			key: counter++,
			rest: file.webkitRelativePath === '' ? file.name : parts.slice(1).join('/'),
			content,
			pasted: false,
			binary
		});
	}
	rows.value = picked;
	serverProblems.value = [];
	input.value = '';
}

function addPasted(): void {
	rows.value.push({ key: counter++, rest: '', content: '', pasted: true, binary: false });
}

function remove(row: Row): void {
	rows.value = rows.value.filter((candidate) => candidate !== row);
	serverProblems.value = [];
}

function submit(): void {
	if (!ready.value) return;
	request ??= deliver().finally(() => {
		request = null;
	});
}

async function deliver(): Promise<void> {
	error.value = null;
	serverProblems.value = [];
	busy.value = true;
	try {
		const operation = await releases.deliverEdit(
			props.orgId,
			props.siteId,
			body.value,
			crypto.randomUUID()
		);
		await navigateTo(`/new/progress/${operation.id}`);
	} catch (cause) {
		const failure = toApiClientError(cause);
		const sent = (failure.details as { problems?: ModifyProblem[] } | null)?.problems;
		serverProblems.value = Array.isArray(sent) ? sent : [];
		error.value = failure.message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<section
		class="flex max-w-3xl flex-col gap-4"
		aria-label="Deliver an edit"
	>
		<div v-if="!open">
			<UButton
				color="neutral"
				variant="outline"
				icon="i-lucide-upload"
				@click="open = true"
				>Deliver an Edit</UButton
			>
		</div>
		<form
			v-else
			class="flex flex-col gap-4 rounded-lg border border-default p-4"
			@submit.prevent="submit()"
		>
			<h2 class="text-base font-medium text-highlighted">Deliver an Edit</h2>
			<p class="text-sm text-muted">
				Send the whole module, theme or profile. The site keeps what you send and removes
				any file of that name you leave out. Files must be text. A restore point is taken
				first, the site checks the new files, and an edit that passes goes into the code
				history with its files, so you can go back to it.
			</p>

			<div class="flex flex-wrap gap-4">
				<label class="flex flex-col gap-1 text-sm text-default">
					<span class="font-medium text-highlighted">Type</span>
					<select
						v-model="kind"
						class="rounded-md border border-default bg-default px-3 py-2"
					>
						<option
							v-for="option in KINDS"
							:key="option.value"
							:value="option.value"
						>
							{{ option.label }}
						</option>
					</select>
				</label>
				<div class="flex min-w-48 flex-1 flex-col gap-1 text-sm text-default">
					<label
						for="edit-name"
						class="font-medium text-highlighted"
						>Machine Name</label
					>
					<UInput
						id="edit-name"
						v-model="name"
						autocomplete="off"
						placeholder="my_module"
					/>
					<p
						v-if="nameProblem"
						role="alert"
						class="text-sm text-red-700 dark:text-red-400"
					>
						{{ nameProblem }}
					</p>
				</div>
			</div>

			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium text-highlighted">Files</span>
				<div class="flex flex-wrap gap-2">
					<label
						class="inline-flex cursor-pointer items-center gap-2 rounded-md border border-default px-3 py-2 text-sm text-default"
					>
						<UIcon
							name="i-lucide-folder-up"
							class="size-4"
							aria-hidden="true"
						/>
						<span>Choose a Folder</span>
						<input
							type="file"
							class="sr-only"
							multiple
							webkitdirectory
							@change="pick"
						/>
					</label>
					<UButton
						color="neutral"
						variant="outline"
						icon="i-lucide-clipboard-paste"
						@click="addPasted()"
						>Add a Pasted File</UButton
					>
				</div>
				<ul
					v-if="rows.length > 0"
					class="flex flex-col rounded-lg border border-default"
				>
					<li
						v-for="(row, index) in rows"
						:key="row.key"
						class="flex flex-col gap-2 border-b border-default p-3 last:border-b-0"
					>
						<div class="flex items-end gap-2">
							<div class="flex flex-1 flex-col gap-1 text-sm">
								<label
									:for="`edit-path-${row.key}`"
									class="font-medium text-highlighted"
									>Path in the Folder</label
								>
								<UInput
									:id="`edit-path-${row.key}`"
									v-model="row.rest"
									autocomplete="off"
									placeholder="src/Controller/Example.php"
								/>
							</div>
							<UButton
								color="neutral"
								variant="outline"
								icon="i-lucide-x"
								:aria-label="`Remove file ${index + 1}`"
								@click="remove(row)"
								>Remove</UButton
							>
						</div>
						<div
							v-if="row.pasted"
							class="flex flex-col gap-1 text-sm"
						>
							<label
								:for="`edit-content-${row.key}`"
								class="font-medium text-highlighted"
								>Content</label
							>
							<UTextarea
								:id="`edit-content-${row.key}`"
								v-model="row.content"
								:rows="6"
							/>
						</div>
						<span
							v-else
							class="text-sm text-muted"
							>{{ sizeOf(row) }} bytes</span
						>
						<p
							v-if="problemOf(row)"
							role="alert"
							class="text-sm text-red-700 dark:text-red-400"
						>
							{{ problemOf(row) }}
						</p>
					</li>
				</ul>
				<p
					v-for="problem in setProblems"
					:key="problem.message"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ problem.message }}
				</p>
				<p
					v-if="requestProblem"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ requestProblem }}
				</p>
			</div>

			<div class="flex flex-col gap-1 text-sm">
				<label
					for="edit-note"
					class="font-medium text-highlighted"
					>Note</label
				>
				<UInput
					id="edit-note"
					v-model="note"
					autocomplete="off"
					placeholder="What this edit changes"
				/>
				<p
					v-if="noteProblem"
					role="alert"
					class="text-sm text-red-700 dark:text-red-400"
				>
					{{ noteProblem }}
				</p>
			</div>

			<p
				v-if="error"
				role="alert"
				class="text-sm text-red-700 dark:text-red-400"
			>
				{{ error }}
			</p>
			<div class="flex gap-2">
				<UButton
					type="submit"
					color="primary"
					:loading="busy"
					:disabled="!ready || busy"
					>Deliver the Edit</UButton
				>
				<UButton
					color="neutral"
					variant="outline"
					:disabled="busy"
					@click="open = false"
					>Cancel</UButton
				>
			</div>
		</form>
	</section>
</template>
