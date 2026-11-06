import { readFileSync, writeFileSync } from 'node:fs';
import {
	fromBase64Url,
	sha256Digest,
	signingKeyFromSeed,
	siteId
} from '../../../contracts/src/common';
import type { AuthorityState } from '../../../contracts/src/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import { hourOf, isView } from '../../../dispatch/src/counting';
import { signSpike, type SpikeBody } from '../../../dispatch/src/spike';
import { coloOf, summarize } from '../revocation/plan';
import {
	ARMS,
	DEFAULTS,
	PRICE_NAMES,
	TERMINATE_AT,
	TERMINATION_NOTE,
	added,
	checkApply,
	checkParams,
	controlSiteId,
	counted,
	discrepancy,
	estimate,
	hostFor,
	hybridLimit,
	isTerminationTrial,
	parsePriceSheet,
	parseReadout,
	resourceList,
	siteIdFor,
	trialSeconds,
	type Arm,
	type Params,
	type PriceSheet,
	type Readout
} from './plan';

function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

function number(name: string, fallback: number): number {
	const raw = flag(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
	return value;
}

const params: Params = {
	trialsPerArm: number('--trials', DEFAULTS.trialsPerArm),
	rate: number('--rate', DEFAULTS.rate),
	requestsPerTrial: number('--requests', DEFAULTS.requestsPerTrial),
	batchSize: number('--batch-size', DEFAULTS.batchSize),
	flushMs: number('--flush-ms', DEFAULTS.flushMs),
	hybridLimitFraction: number('--hybrid-limit-fraction', DEFAULTS.hybridLimitFraction),
	settleS: number('--settle', DEFAULTS.settleS),
	doMemoryGb: DEFAULTS.doMemoryGb
};

function loadSheet(): PriceSheet | null {
	const path = flag('--prices');
	if (!path) return null;
	const checked = parsePriceSheet(JSON.parse(readFileSync(path, 'utf8')));
	if (!checked.ok) throw new Error(`price sheet ${path}: ${checked.reason}`);
	return checked.sheet;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

function printPlan(sheet: PriceSheet | null): void {
	const plan = estimate(params, sheet);
	console.log('Counting comparison: dry run, nothing is created or called.\n');
	console.log('Resources the run needs (main creates them; this script creates none):');
	for (const line of resourceList(params)) console.log(`  - ${line}`);
	console.log('\nParameters:', JSON.stringify(params));
	console.log(
		`Each trial sends ${params.requestsPerTrial} requests at ${params.rate} a second ` +
			`(${(params.requestsPerTrial / params.rate).toFixed(0)} s) plus ${params.settleS} s to settle; ` +
			`hybrid sites get a limit of ${hybridLimit(params)} views.`
	);
	console.log('\nModel: one isolate per site, steady arrivals, the counter always answering,');
	console.log('every trial inside one hour. The run records the real counts beside these.\n');
	console.log('Arms, requests and counter calls (Durable Object requests to UsageCounter):');
	for (const row of plan.arms) {
		console.log(
			`  ${row.arm.padEnd(14)} sites ${row.sites}  requests ${row.requests}  ` +
				`counter calls ${row.counterCalls} (${row.counterCallsPerSite} a site)  ` +
				`rows written ${row.rowsWritten}  rows read ${row.rowsRead}`
		);
	}
	console.log(`\nControl site, counting off: ${plan.controlRequests} requests`);
	console.log(`Total requests          ${plan.totalRequests}`);
	console.log(`Counter calls           ${plan.totalCounterCalls}`);
	console.log(`Tenant count calls      ${plan.totalTenantCountCalls}`);
	console.log(`Object requests         ${plan.totalObjectRequests}`);
	console.log(`Rows written / read     ${plan.rowsWritten} / ${plan.rowsRead}`);
	console.log(
		`Object GB-seconds (max) ${plan.doGbSeconds.toFixed(1)} over ${trialSeconds(params)} s a trial`
	);
	if (plan.cost && sheet) {
		console.log(`Gross at the given prices ${usd(plan.cost.grossUsd)}`);
		for (const name of PRICE_NAMES) {
			const price = sheet[name];
			console.log(
				`  ${name.padEnd(15)} ${usd(plan.cost.lines[name])}  at ${price.usdPerMillion} per million, ` +
					`${price.includedPerMonth} included a month`
			);
			console.log(`    ${price.page}, fetched ${price.fetched}, read as ${price.read}`);
		}
		console.log(
			`Above the included use  ${usd(plan.cost.marginalUsd)} (assumes nothing else uses it)`
		);
	} else {
		console.log(
			'Cost not estimated: pass --prices <file> with each price, its page and its date.'
		);
	}
	console.log(
		'The tenant script requests billed on the dispatch namespace plan are not priced here.'
	);
	console.log('\n' + TERMINATION_NOTE.join('\n'));
	console.log('\nRun with --apply and SPIKE_CONFIRM=1 only after reading the figures above.');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Sample = { ms: number; status: number; view: boolean; colo: string | null };

async function sample(url: string): Promise<Sample> {
	const start = performance.now();
	try {
		const response = await fetch(url, { redirect: 'manual' });
		await response.arrayBuffer();
		return {
			ms: performance.now() - start,
			status: response.status,
			view: isView(response.status, response.headers.get('content-type')),
			colo: coloOf(response.headers.get('cf-ray'))
		};
	} catch {
		return { ms: performance.now() - start, status: 0, view: false, colo: null };
	}
}

type Trial = {
	arm: Arm;
	n: number;
	terminated: boolean;
	siteId: string;
	host: string;
	sent: number;
	clientViews: number;
	tenantViews: number | null;
	addedMs: { p50: number | null; p95: number | null };
	controlP50Ms: number | null;
	counter: {
		calls: number;
		puts: number;
		refused: number;
		duplicateViews: number;
		ackedViews: number;
		issuedViews: number;
		origins: number;
		accountingAvailable: boolean;
		statsSince: number;
	} | null;
	discrepancy: { acked: number; issued: number } | null;
};

async function run(): Promise<void> {
	const template = flag('--host-template') as string;
	const controlUrl = flag('--control-url') as string;
	const offHost = flag('--off-host') as string;
	const readUrl = flag('--read-url') as string;
	const evictUrl = flag('--evict-url') as string;
	const runId = flag('--run-id') ?? 'r1';
	const out = flag('--out') ?? 'counting-reading.json';
	const key = await signingKeyFromSeed(fromBase64Url(process.env.SPIKE_CONTROL_SEED as string));
	const accessRuleHash = await sha256Digest('spike');
	const sheet = loadSheet();

	const apply = async (state: AuthorityState): Promise<void> => {
		const message = await signApply(state, Date.now(), key.privateKey);
		const response = await fetch(controlUrl, { method: 'POST', body: JSON.stringify(message) });
		const body = (await response.json()) as { ok?: boolean; code?: string };
		if (!response.ok || body.ok !== true) {
			throw new Error(`apply refused: ${response.status} ${body.code ?? ''}`);
		}
	};
	const active = (id: string, viewsPerMonth: number): AuthorityState => ({
		siteId: siteId.parse(id),
		epoch: 1,
		generation: 1,
		state: 'active',
		risk: 'established',
		limits: { cpuMs: 50, subRequests: 20, viewsPerMonth },
		accessRuleHash
	});

	const spike = async (url: string, body: SpikeBody): Promise<Response> => {
		const message = await signSpike(body, Date.now(), key.privateKey);
		return fetch(url, { method: 'POST', body: JSON.stringify(message), redirect: 'manual' });
	};

	const readCounter = async (id: string, from: number, to: number): Promise<Readout | null> => {
		const hours: number[] = [];
		for (let h = hourOf(from); h <= hourOf(to); h += 3_600_000) hours.push(h);
		const response = await spike(readUrl, { op: 'counts', siteId: id, hours });
		if (!response.ok) return null;
		const checked = parseReadout(await response.json());
		return checked.ok ? checked.readout : null;
	};

	const readTenant = async (host: string): Promise<number | null> => {
		try {
			const response = await fetch(`https://${host}/__count`);
			const body = (await response.json()) as { count?: number };
			return typeof body.count === 'number' ? body.count : null;
		} catch {
			return null;
		}
	};

	await apply(active(controlSiteId(runId), 1_000_000_000));
	const intervalMs = 1000 / params.rate;
	const trials: Trial[] = [];
	const controlP50: number[] = [];
	const controlAll: Sample[] = [];

	for (const arm of ARMS) {
		for (let n = 0; n < params.trialsPerArm; n++) {
			const id = siteIdFor(runId, arm, n);
			const host = hostFor(template, arm, n);
			const limit = arm === 'hybrid' ? hybridLimit(params) : 1_000_000_000;
			await apply(active(id, limit));
			const terminated = isTerminationTrial(n);
			const startedAt = Date.now();
			const mine: Sample[] = [];
			const control: Sample[] = [];
			const pending: Promise<unknown>[] = [];
			for (let i = 0; i < params.requestsPerTrial; i++) {
				pending.push(sample(`https://${host}/`).then((s) => void mine.push(s)));
				pending.push(sample(`https://${offHost}/`).then((s) => void control.push(s)));
				if (terminated && i === Math.floor(params.requestsPerTrial * TERMINATE_AT)) {
					pending.push(spike(evictUrl, { op: 'evict' }).catch(() => undefined));
				}
				await sleep(intervalMs);
			}
			await Promise.all(pending);
			await sleep(params.settleS * 1000);
			const tenantViews = await readTenant(host);
			const readout = await readCounter(id, startedAt, Date.now());
			const totals = readout ? counted(readout.hours) : null;
			const okLatency = (list: Sample[]) => list.filter((s) => s.view).map((s) => s.ms);
			const control50 = summarize(okLatency(control)).p50;
			if (control50 !== null) controlP50.push(control50);
			controlAll.push(...control);
			trials.push({
				arm,
				n,
				terminated,
				siteId: id,
				host,
				sent: mine.length,
				clientViews: mine.filter((s) => s.view).length,
				tenantViews,
				addedMs: added(okLatency(mine), okLatency(control)),
				controlP50Ms: control50,
				counter:
					readout && totals
						? {
								calls: readout.counts.calls,
								puts: readout.counts.puts,
								refused: readout.counts.refused,
								duplicateViews: readout.counts.duplicateViews,
								ackedViews: totals.acked,
								issuedViews: totals.issued,
								origins: totals.origins,
								accountingAvailable: totals.available,
								statsSince: readout.counts.since
							}
						: null,
				discrepancy:
					totals && tenantViews !== null ? discrepancy(totals, tenantViews) : null
			});
			const last = trials[trials.length - 1] as Trial;
			console.log(
				`${arm} ${n}${terminated ? ' (terminated)' : ''}: client ${last.clientViews}, ` +
					`tenant ${last.tenantViews}, counter ${last.counter?.ackedViews}`
			);
		}
	}

	const pick = (
		arm: Arm,
		terminated: boolean | null,
		f: (t: Trial) => number | null | undefined
	) =>
		summarize(
			trials
				.filter(
					(t) => t.arm === arm && (terminated === null || t.terminated === terminated)
				)
				.map(f)
				.filter((v): v is number => typeof v === 'number')
		);
	const reading = {
		kind: 'counting-comparison',
		takenAt: new Date().toISOString(),
		params,
		priceSheet: sheet,
		clock: 'client performance.now; added latency is the trial p50 or p95 minus the control site probed at the same moments',
		termination: TERMINATION_NOTE,
		arms: ARMS.map((arm) => ({
			arm,
			addedP50Ms: pick(arm, null, (t) => t.addedMs.p50),
			addedP95Ms: pick(arm, null, (t) => t.addedMs.p95),
			counterCalls: pick(arm, null, (t) => t.counter?.calls),
			rowsWritten: pick(arm, null, (t) => t.counter?.puts),
			duplicateViews: pick(arm, null, (t) => t.counter?.duplicateViews),
			ackedMinusTenant: {
				clean: pick(arm, false, (t) => t.discrepancy?.acked),
				terminated: pick(arm, true, (t) => t.discrepancy?.acked)
			},
			issuedMinusTenant: {
				clean: pick(arm, false, (t) => t.discrepancy?.issued),
				terminated: pick(arm, true, (t) => t.discrepancy?.issued)
			},
			origins: pick(arm, null, (t) => t.counter?.origins)
		})),
		control: {
			requests: controlAll.length,
			non2xx: controlAll.filter((s) => s.status < 200 || s.status >= 300).length,
			p50PerTrialMs: summarize(controlP50)
		},
		trials
	};
	writeFileSync(out, JSON.stringify(reading, null, '\t') + '\n');
	console.log(`wrote ${out}`);
}

const check = checkApply(process.argv, process.env);
if (!check.ok) {
	console.error(check.reason);
	process.exit(2);
}
const bad = checkParams(params);
if (bad) {
	console.error(bad);
	process.exit(2);
}

if (process.argv.includes('--routes')) {
	const template = flag('--host-template') ?? 'spike-{arm}-{n}.stage.example';
	const script = flag('--script') ?? 'spike-count-tenant';
	const runId = flag('--run-id') ?? 'r1';
	const entries: Record<string, string> = {};
	for (const arm of ARMS) {
		for (let n = 0; n < params.trialsPerArm; n++) {
			const id = siteIdFor(runId, arm, n);
			entries[hostFor(template, arm, n)] = JSON.stringify({
				v: 1,
				siteId: id,
				script,
				epoch: 1
			});
			entries[`mech:${id}`] = arm;
		}
	}
	const offHost = flag('--off-host');
	if (offHost) {
		entries[offHost] = JSON.stringify({ v: 1, siteId: controlSiteId(runId), script, epoch: 1 });
	}
	console.log(JSON.stringify(entries, null, '\t'));
} else if (process.argv.includes('--apply')) {
	await run();
} else {
	printPlan(loadSheet());
}
