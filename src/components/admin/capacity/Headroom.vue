<script setup lang="ts">
import type { HeadroomView } from '~/shared/capacity';

const props = defineProps<{ view: HeadroomView }>();

const number = (value: number) => value.toLocaleString('en-US');

const filled = computed(() => {
	const view = props.view;
	if (view.state !== 'ok' || view.kvLimit <= 0) return 0;
	return Math.min(100, (view.kvNamespaces * 100) / view.kvLimit);
});
</script>

<template>
	<section
		class="flex max-w-md flex-col gap-3"
		aria-labelledby="capacity-headroom"
	>
		<h2
			id="capacity-headroom"
			class="text-lg font-semibold text-highlighted"
		>
			Account Headroom
		</h2>
		<p
			v-if="view.state !== 'ok'"
			class="text-muted"
			role="status"
		>
			{{
				view.state === 'not_configured'
					? 'The dashboard has no Cloudflare credentials yet, so it cannot read the account.'
					: 'Account headroom could not be read. The next refresh tries again.'
			}}
		</p>
		<template v-else>
			<dl class="grid grid-cols-2 gap-y-2">
				<dt class="text-muted">KV Namespaces</dt>
				<dd class="text-right font-semibold text-highlighted">
					{{ number(view.kvNamespaces) }} of {{ number(view.kvLimit) }}
				</dd>
				<dt class="text-muted">R2 Buckets</dt>
				<dd class="text-right font-medium text-highlighted">{{ number(view.buckets) }}</dd>
				<dt class="text-muted">Worker Scripts</dt>
				<dd class="text-right font-medium text-highlighted">
					{{ view.scripts === null ? 'Unknown' : number(view.scripts) }}
				</dd>
				<dt class="text-muted">D1 Databases</dt>
				<dd class="text-right font-medium text-highlighted">
					{{ view.databases === null ? 'Unknown' : number(view.databases) }}
				</dd>
				<dt class="text-muted">API Requests Left</dt>
				<dd class="text-right font-medium text-highlighted">
					<template v-if="view.rate.remaining === null">Unknown</template>
					<template v-else>
						{{ number(view.rate.remaining) }}
						<template v-if="view.rate.quota !== null"
							>of {{ number(view.rate.quota) }}</template
						>
					</template>
				</dd>
				<dt class="text-muted">Window Resets In</dt>
				<dd class="text-right font-medium text-highlighted">
					{{
						view.rate.resetSeconds === null
							? 'Unknown'
							: `${view.rate.resetSeconds} seconds`
					}}
				</dd>
			</dl>
			<div
				aria-hidden="true"
				class="h-2 w-full overflow-hidden rounded-full bg-elevated"
			>
				<div
					class="h-2 bg-primary"
					:style="{ width: `${filled}%` }"
				/>
			</div>
			<p class="text-sm text-muted">
				The namespace limit is Cloudflare's default of {{ number(view.kvLimit) }}. The
				limits for buckets, scripts and databases are not read.
			</p>
		</template>
	</section>
</template>
