<script setup lang="ts">
import type { PilotReportView } from '~/stores/pilots';

const props = defineProps<{
	report: PilotReportView;
	exportHref: string;
}>();

const stateLabel: Record<string, string> = {
	exact: 'Exact',
	estimated: 'Estimated',
	unaccounted: 'Unaccounted'
};

const dollars = (cents: number | null) =>
	cents === null
		? 'Not Set'
		: `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const hours = (minutes: number) => `${(minutes / 60).toFixed(1)} hours`;

const printPage = () => window.print();
</script>

<template>
	<article class="space-y-6 print:space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-xl font-semibold text-default">{{ report.name }} Report</h2>
				<p class="text-sm text-muted">
					Started {{ report.startDate
					}}<span v-if="report.sponsor">, sponsor {{ report.sponsor }}</span>
				</p>
			</div>
			<div class="flex gap-2 print:hidden">
				<button
					type="button"
					class="rounded-md border border-default px-3 py-2 text-default"
					@click="printPage"
				>
					Save as PDF
				</button>
				<a
					class="rounded-md border border-default px-3 py-2 text-default"
					:href="exportHref"
				>
					Download CSV
				</a>
			</div>
		</header>

		<section>
			<h3 class="font-semibold text-default">Success Criteria</h3>
			<p
				v-if="report.successCriteria"
				class="mt-1 whitespace-pre-line text-default"
			>
				{{ report.successCriteria }}
			</p>
			<p
				v-else
				class="mt-1 text-muted"
			>
				The owner has not written success criteria.
			</p>
		</section>

		<section>
			<h3 class="font-semibold text-default">Hosting Cost</h3>
			<dl class="mt-1 grid gap-2 sm:grid-cols-2">
				<div>
					<dt class="text-sm text-muted">Before the Pilot</dt>
					<dd class="text-default">{{ dollars(report.hosting.baselineSpendCents) }}</dd>
				</div>
				<div>
					<dt class="text-sm text-muted">With Drupflare</dt>
					<dd class="text-default">Not Measured</dd>
				</div>
				<div>
					<dt class="text-sm text-muted">Views in the Pilot</dt>
					<dd class="text-default">
						{{ report.drupflare.views.toLocaleString('en-US') }}
						({{ stateLabel[report.drupflare.state] }})
					</dd>
				</div>
				<div>
					<dt class="text-sm text-muted">To Continue</dt>
					<dd class="text-default">
						{{ dollars(report.drupflare.continuationCostCents) }}
					</dd>
				</div>
			</dl>
		</section>

		<section>
			<h3 class="font-semibold text-default">Staff Time</h3>
			<p class="mt-1 text-default">
				Before: {{ report.staff.baselineHours ?? 'Not Set' }} hours a month. Observed:
				{{ hours(report.staff.observedMinutes) }} across
				{{ report.staff.observedEntries }} tasks.
			</p>
		</section>

		<section>
			<h3 class="font-semibold text-default">What Failed and What Stayed Unsupported</h3>
			<p class="mt-1 text-default">
				{{ report.negativeResults }} negative results are listed below.
			</p>
			<ul class="mt-2 list-disc space-y-1 pl-5 text-default">
				<li
					v-for="row in report.failures"
					:key="row.id"
				>
					Failure: {{ row.text }}
				</li>
				<li
					v-for="row in report.unsupported"
					:key="row.id"
				>
					Unsupported: {{ row.text }}
				</li>
			</ul>
		</section>

		<section v-if="report.exceptions.length > 0">
			<h3 class="font-semibold text-default">Exceptions</h3>
			<ul class="mt-2 list-disc space-y-1 pl-5 text-default">
				<li
					v-for="row in report.exceptions"
					:key="row.id"
				>
					{{ row.text }}
				</li>
			</ul>
		</section>
	</article>
</template>
