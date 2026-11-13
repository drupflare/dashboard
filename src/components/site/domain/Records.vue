<script setup lang="ts">
import { DNS_PURPOSE_COPY, dnsRecordHint, type DnsRecord } from '~/shared/domain-copy';

const props = defineProps<{ hostname: string; records: DnsRecord[] }>();

const hints = computed(() =>
	props.records
		.map((record) => dnsRecordHint(record, props.hostname))
		.filter((hint, index, all): hint is string => hint !== null && all.indexOf(hint) === index)
);
</script>

<template>
	<div
		class="flex flex-col gap-2 rounded-lg border border-default p-4"
		data-test="records"
	>
		<h2 class="text-sm font-semibold text-highlighted">What You Do at Your DNS Provider</h2>
		<p class="text-sm text-default">
			Your domain lives in your own DNS, so Drupflare cannot add these for you. Add each
			record exactly as shown.
		</p>
		<ul class="flex flex-col gap-3 text-sm text-default">
			<li
				v-for="record in records"
				:key="`${record.type}-${record.name}-${record.value}`"
				:data-test="`record-${record.purpose}`"
				class="flex flex-col gap-0.5"
			>
				<span class="font-medium text-highlighted">
					{{ DNS_PURPOSE_COPY[record.purpose] }}
				</span>
				<span>
					Type <code>{{ record.type }}</code
					>, name <code class="wrap-break-word">{{ record.name }}</code
					>, value <code class="wrap-break-word">{{ record.value }}</code>
				</span>
			</li>
		</ul>
		<p
			v-for="hint in hints"
			:key="hint"
			class="text-sm text-muted"
		>
			{{ hint }}
		</p>
	</div>
</template>
