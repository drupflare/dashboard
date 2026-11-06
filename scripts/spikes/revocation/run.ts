import { writeFileSync } from 'node:fs';
import {
	fromBase64Url,
	sha256Digest,
	signingKeyFromSeed,
	siteId
} from '../../../contracts/src/common';
import type { AuthorityState } from '../../../contracts/src/site-auth';
import { signApply } from '../../../dispatch/src/authority';
import {
	ARMS,
	DEFAULTS,
	PRICES,
	checkApply,
	coloOf,
	estimate,
	hostFor,
	isStrictTrial,
	resourceList,
	siteIdFor,
	staleWindowMs,
	summarize,
	type Arm,
	type Params,
	type Probe
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
	probeHz: number('--hz', DEFAULTS.probeHz),
	warmS: number('--warm', DEFAULTS.warmS),
	postS: number('--post', DEFAULTS.postS),
	isolates: number('--isolates', DEFAULTS.isolates),
	leaseS: DEFAULTS.leaseS,
	strictFraction: number('--strict-fraction', DEFAULTS.strictFraction),
	doMemoryGb: DEFAULTS.doMemoryGb
};

function printPlan(): void {
	const plan = estimate(params);
	console.log('Revocation consistency spike: dry run, nothing is created or called.\n');
	console.log('Resources the run needs (main creates them; this script creates none):');
	for (const line of resourceList(params)) console.log(`  - ${line}`);
	console.log('\nParameters:', JSON.stringify(params));
	console.log('\nArms, requests and Durable Object requests:');
	for (const row of plan.arms) {
		console.log(
			`  ${row.arm.padEnd(12)} sites ${row.sites}  strict sites ${row.strictSites}  ` +
				`requests ${row.requests}  object requests ${row.doRequests}`
		);
	}
	console.log(`\nTotal requests          ${plan.totalRequests}`);
	console.log(`Total object requests   ${plan.totalDoRequests}`);
	console.log(`Object GB-seconds (max) ${plan.doGbSeconds.toFixed(1)}`);
	console.log(`Gross at list price     $${plan.grossUsd.toFixed(4)}`);
	console.log(`  object requests       $${plan.grossDoRequestUsd.toFixed(4)}`);
	console.log(`  object duration       $${plan.grossDoDurationUsd.toFixed(4)}`);
	console.log(`  dispatch requests     $${plan.grossWorkerRequestUsd.toFixed(4)}`);
	console.log(
		`Above the included use  $${plan.marginalUsd.toFixed(4)} (assumes nothing else uses it)`
	);
	console.log(`Prices: ${PRICES.source}`);
	console.log(
		'The tenant script requests billed on the dispatch namespace plan are not priced here.'
	);
	console.log('\nRun with --apply and SPIKE_CONFIRM=1 only after reading the figures above.');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Trial = {
	arm: Arm;
	n: number;
	host: string;
	siteId: string;
	strict: boolean;
	probes: Probe[];
	commitAck: number;
	staleMs: number;
};

async function probe(url: string, host: string, clock: () => number): Promise<Probe> {
	const start = clock();
	try {
		const response = await fetch(url.replace('{host}', host), { redirect: 'manual' });
		await response.arrayBuffer();
		return {
			start,
			end: clock(),
			status: response.status,
			colo: coloOf(response.headers.get('cf-ray'))
		};
	} catch {
		return { start, end: clock(), status: 0, colo: null };
	}
}

async function run(): Promise<void> {
	const template = flag('--host-template') as string;
	const controlUrl = flag('--control-url') as string;
	const controlHost = flag('--control-host') as string;
	const out = flag('--out') ?? 'revocation-reading.json';
	const seed = process.env.SPIKE_CONTROL_SEED as string;
	const key = await signingKeyFromSeed(fromBase64Url(seed));
	const clock = () => performance.now();
	const accessRuleHash = await sha256Digest('spike');

	const apply = async (state: AuthorityState): Promise<number> => {
		const message = await signApply(state, Date.now(), key.privateKey);
		const response = await fetch(controlUrl, { method: 'POST', body: JSON.stringify(message) });
		const body = (await response.json()) as { ok?: boolean; code?: string };
		if (!response.ok || body.ok !== true) {
			throw new Error(`apply refused: ${response.status} ${body.code ?? ''}`);
		}
		return clock();
	};

	const stateFor = (
		trial: Trial,
		generation: number,
		state: AuthorityState['state']
	): AuthorityState => ({
		siteId: siteId.parse(trial.siteId),
		epoch: 1,
		generation,
		state,
		risk: trial.strict ? 'new-free' : 'established',
		limits: { cpuMs: 50, subRequests: 20 },
		accessRuleHash
	});

	const trials: Trial[] = [];
	for (const arm of ARMS) {
		for (let n = 0; n < params.trialsPerArm; n++) {
			trials.push({
				arm,
				n,
				host: hostFor(template, arm, n),
				siteId: siteIdFor(arm, n),
				strict: isStrictTrial(arm, n, params.trialsPerArm, params.strictFraction),
				probes: [],
				commitAck: 0,
				staleMs: 0
			});
		}
	}

	const control: Probe[] = [];
	const controlState: AuthorityState = {
		siteId: siteId.parse('site_spikecontrol0001'),
		epoch: 1,
		generation: 1,
		state: 'active',
		risk: 'established',
		limits: { cpuMs: 50, subRequests: 20 },
		accessRuleHash
	};
	await apply(controlState);

	const intervalMs = 1000 / params.probeHz;
	const urlFor = `https://{host}/`;
	for (const trial of trials) {
		await apply(stateFor(trial, 1, 'active'));
		const pending: Promise<void>[] = [];
		const fire = (target: Probe[], host: string) =>
			pending.push(probe(urlFor, host, clock).then((p) => void target.push(p)));
		const phase = async (seconds: number) => {
			const ticks = Math.round(seconds * params.probeHz);
			for (let i = 0; i < ticks; i++) {
				fire(trial.probes, trial.host);
				fire(control, controlHost);
				await sleep(intervalMs);
			}
		};
		await phase(params.warmS);
		trial.commitAck = await apply(stateFor(trial, 2, 'revoked'));
		await phase(params.postS);
		await Promise.all(pending);
		trial.staleMs = staleWindowMs(trial.probes, trial.commitAck);
		console.log(`${trial.arm} ${trial.n}: stale window ${trial.staleMs.toFixed(0)} ms`);
	}

	const reading = {
		kind: 'revocation-consistency',
		takenAt: new Date().toISOString(),
		params,
		clock: 'client performance.now; the commit time is the ack of the revoke request, so the window includes one round trip',
		arms: ARMS.map((arm) => {
			const mine = trials.filter((t) => t.arm === arm);
			const colos: Record<string, number> = {};
			for (const t of mine)
				for (const p of t.probes) if (p.colo) colos[p.colo] = (colos[p.colo] ?? 0) + 1;
			const warm2xx = mine.flatMap((t) =>
				t.probes
					.filter((p) => p.start < t.commitAck && p.status >= 200 && p.status < 300)
					.map((p) => p.end - p.start)
			);
			const byClass = (strict: boolean) =>
				summarize(mine.filter((t) => t.strict === strict).map((t) => t.staleMs));
			return {
				arm,
				staleWindowMs: summarize(mine.map((t) => t.staleMs)),
				strictTrials: byClass(true),
				leaseTrials: byClass(false),
				warmLatencyMs: summarize(warm2xx),
				colos,
				trials: mine.map((t) => ({ n: t.n, strict: t.strict, staleMs: t.staleMs }))
			};
		}),
		control: {
			requests: control.length,
			non2xx: control.filter((p) => p.status < 200 || p.status >= 300).length,
			latencyMs: summarize(control.map((p) => p.end - p.start))
		}
	};
	writeFileSync(out, JSON.stringify(reading, null, '\t') + '\n');
	console.log(`wrote ${out}`);
}

const check = checkApply(process.argv, process.env);
if (!check.ok) {
	console.error(check.reason);
	process.exit(2);
}

if (process.argv.includes('--routes')) {
	const template = flag('--host-template') ?? 'spike-{arm}-{n}.stage.example';
	const script = flag('--script') ?? 'spike-tenant';
	const entries: Record<string, string> = {};
	for (const arm of ARMS) {
		for (let n = 0; n < params.trialsPerArm; n++) {
			entries[hostFor(template, arm, n)] = JSON.stringify({
				v: 1,
				siteId: siteIdFor(arm, n),
				script,
				epoch: 1
			});
		}
	}
	const controlHost = flag('--control-host');
	if (controlHost) {
		entries[controlHost] = JSON.stringify({
			v: 1,
			siteId: 'site_spikecontrol0001',
			script,
			epoch: 1
		});
	}
	console.log(JSON.stringify(entries, null, '\t'));
} else if (process.argv.includes('--apply')) {
	await run();
} else {
	printPlan();
}
