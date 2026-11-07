<script setup lang="ts">
import type { HealthNodeView } from '~/shared/health/view';

defineOptions({ name: 'HealthTreeNode' });

const props = defineProps<{ node: HealthNodeView }>();

const LEVEL: Record<string, { label: string; icon: string; tone: string }> = {
	ok: { label: 'OK', icon: 'i-lucide-circle-check', tone: 'text-leaf-700 dark:text-leaf-300' },
	info: { label: 'Info', icon: 'i-lucide-info', tone: 'text-brand-700 dark:text-brand-300' },
	warn: {
		label: 'Warning',
		icon: 'i-lucide-triangle-alert',
		tone: 'text-amber-800 dark:text-amber-300'
	},
	error: { label: 'Error', icon: 'i-lucide-circle-x', tone: 'text-red-700 dark:text-red-400' },
	critical: {
		label: 'Critical',
		icon: 'i-lucide-octagon-alert',
		tone: 'text-red-700 dark:text-red-400'
	}
};

const HISTORY_SHOWN = 5;

const level = computed(() => LEVEL[props.node.level] ?? LEVEL.warn!);
const hasChildren = computed(() => props.node.children.length > 0);
const open = ref(props.node.level !== 'ok');
const panel = useId();

const history = computed(() => props.node.history.slice(-HISTORY_SHOWN).reverse());

// a fixed UTC format, so the server and the browser print the same text
function stamp(atMs: number): string {
	return `${new Date(atMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
</script>

<template>
	<li class="flex flex-col gap-2 py-3">
		<div class="flex flex-wrap items-start gap-x-3 gap-y-1">
			<button
				v-if="hasChildren"
				type="button"
				class="inline-flex items-center gap-1 rounded-md text-left font-medium text-highlighted focus-visible:outline-2"
				:aria-expanded="open"
				:aria-controls="panel"
				@click="open = !open"
			>
				<UIcon
					:name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span class="wrap-break-word">{{ node.title }}</span>
			</button>
			<span
				v-else
				class="wrap-break-word font-medium text-highlighted"
				>{{ node.title }}</span
			>
			<span
				class="inline-flex items-center gap-1.5 text-sm"
				:class="level.tone"
				data-test="node-level"
			>
				<UIcon
					:name="level.icon"
					class="size-4 shrink-0"
					aria-hidden="true"
				/>
				<span>{{ level.label }}</span>
			</span>
		</div>

		<p
			v-if="node.detail"
			class="wrap-break-word text-sm text-muted"
		>
			{{ node.detail }}
		</p>

		<p
			v-if="node.guidance"
			class="text-sm text-default"
		>
			<span class="font-medium">What Happens Next:</span> {{ node.guidance.text }}
		</p>

		<div
			v-if="history.length > 0"
			class="text-sm text-muted"
		>
			<p class="font-medium">Recent History</p>
			<ul class="flex flex-col">
				<li
					v-for="event in history"
					:key="`${event.atMs}-${event.state}`"
				>
					{{ event.state }} at {{ stamp(event.atMs) }}
				</li>
			</ul>
		</div>

		<details
			v-if="node.guidance"
			class="text-sm text-muted"
		>
			<summary class="cursor-pointer font-medium">Diagnostics</summary>
			<dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
				<template
					v-for="row in node.guidance.diagnostics"
					:key="row.label"
				>
					<dt class="font-medium">{{ row.label }}</dt>
					<dd class="wrap-break-word font-mono text-xs">{{ row.value }}</dd>
				</template>
			</dl>
		</details>

		<ul
			v-if="hasChildren"
			v-show="open"
			:id="panel"
			class="ml-4 flex flex-col divide-y divide-default border-l border-default pl-4"
		>
			<HealthTreeNode
				v-for="child in node.children"
				:key="child.id"
				:node="child"
			/>
		</ul>
	</li>
</template>
