<script setup lang="ts">
import { DNS_PURPOSE_COPY, DNS_TYPE_COPY, type DnsRecord } from '~/shared/domain-copy';
import type { DomainCheck } from '~/stores/domain';

type Shown = DnsRecord &
	Partial<Pick<DomainCheck['records'][number], 'status' | 'statusText' | 'found'>>;

defineProps<{
	records: Shown[];
	hazards?: DomainCheck['hazards'];
	// the address record is missing from the list while custom domains are off
	routingLater?: boolean;
	routingLaterText?: string;
}>();
</script>

<template>
	<div
		class="flex flex-col gap-2 rounded-lg border border-default p-4"
		data-test="records"
	>
		<h2 class="text-sm font-semibold text-highlighted">What You Do at Your DNS Provider</h2>
		<p class="text-sm text-default">
			Your domain lives in your own DNS, so Drupflare cannot add these for you. Add each
			record exactly as shown. A new record can take a few minutes to show up here.
		</p>
		<ul class="flex flex-col gap-3 text-sm text-default">
			<li
				v-for="record in records"
				:key="`${record.type}-${record.name}-${record.value}`"
				:data-test="`record-${record.purpose}`"
				:data-status="record.status"
				class="flex flex-col gap-0.5"
			>
				<span class="font-medium text-highlighted">
					{{ DNS_PURPOSE_COPY[record.purpose] }}
					<span
						v-if="record.statusText"
						class="font-normal"
						:class="{
							'text-green-700 dark:text-green-400': record.status === 'ok',
							'text-red-700 dark:text-red-400': record.status === 'wrong',
							'text-muted': record.status === 'missing' || record.status === 'unknown'
						}"
						data-test="status"
					>
						({{ record.statusText }})
					</span>
				</span>
				<span>
					Type <code>{{ record.type }}</code
					>, a {{ DNS_TYPE_COPY[record.type] }}, name
					<code class="wrap-break-word">{{ record.name }}</code
					>, value <code class="wrap-break-word">{{ record.value }}</code>
				</span>
				<span
					v-if="record.found && record.found.length > 0"
					class="text-muted"
					data-test="found"
				>
					Drupflare sees
					<code class="wrap-break-word">{{ record.found.join(', ') }}</code>
					instead.
				</span>
				<span
					v-if="record.note"
					class="text-muted"
					data-test="note"
				>
					{{ record.note }}
				</span>
			</li>
		</ul>
		<p
			v-if="routingLater"
			class="text-sm text-muted"
			data-test="routing-later"
		>
			{{ routingLaterText }}
		</p>
		<ul
			v-if="hazards && hazards.length > 0"
			class="flex flex-col gap-1 text-sm text-amber-800 dark:text-amber-300"
			data-test="hazards"
		>
			<li
				v-for="hazard in hazards"
				:key="hazard.code"
				:data-test="`hazard-${hazard.code}`"
			>
				{{ hazard.text }}
			</li>
		</ul>
	</div>
</template>
