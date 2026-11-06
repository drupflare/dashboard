import { describe, expect, it } from 'vitest';
import { serve, type ServeDeps } from '../../../dispatch/src/serve';
import {
	ARMS,
	DEFAULTS,
	checkApply,
	coloOf,
	estimate,
	hostFor,
	isStrictTrial,
	leaseDoRequests,
	quantile,
	siteIdFor,
	staleWindowMs,
	strictDoRequests,
	summarize
} from '../../../scripts/spikes/revocation/plan';
import { authorityState, makeRig } from './fakes';

const HOST = 'spike.stage.example';

// one isolate probing one site: the number of object calls it makes before and after a revoke
async function simulate(
	risk: 'established' | 'new-free',
	warmS: number,
	postS: number,
	hz: number
) {
	const rig = await makeRig();
	const pending: Promise<unknown>[] = [];
	const state = await authorityState({ risk, epoch: 1 });
	await rig.commit(state);
	const deps: ServeDeps = {
		now: rig.clock.now,
		publicKey: rig.lease.publicKey,
		readRoute: async () =>
			JSON.stringify({ v: 1, siteId: state.siteId, script: 'tenant', epoch: 1 }),
		siteAuth: () => rig.client,
		tenant: () => ({ fetch: async () => new Response('ok') }),
		cache: new Map(),
		inflight: new Map(),
		revoked: new Set(),
		waitUntil: (promise) => void pending.push(promise),
		askTimeoutMs: 5_000
	};
	const start = rig.clock.now();
	let requests = 0;
	const stepMs = 1000 / hz;
	const drive = async (seconds: number) => {
		const ticks = Math.round(seconds * hz);
		for (let i = 0; i < ticks; i++) {
			await serve(new Request(`https://${HOST}/`), deps);
			await Promise.all(pending.splice(0));
			requests++;
			rig.clock.advance(stepMs);
		}
	};
	await drive(warmS);
	const warmRequests = requests;
	await rig.commit({ ...state, generation: 2, state: 'revoked' });
	await drive(postS);
	return { requests, warmRequests, calls: rig.calls.lease + rig.calls.renew, start };
}

describe('dry-run arithmetic', () => {
	it('matches what the code does: strict asks once per request, lease asks about every two thirds of a lease', async () => {
		const p = { ...DEFAULTS, isolates: 1 };
		const strict = await simulate('new-free', p.warmS, p.postS, p.probeHz);
		expect(strict.calls).toBe(strict.warmRequests + 1);
		expect(strict.calls + 2).toBe(strictDoRequests(strict.warmRequests));
		const lease = await simulate('established', p.warmS, p.postS, p.probeHz);
		expect(lease.calls + 2).toBe(leaseDoRequests(p));
	});

	it('counts the same sites and requests in every arm and prices a smaller run lower', () => {
		const full = estimate(DEFAULTS);
		for (const row of full.arms) {
			expect(row.sites).toBe(DEFAULTS.trialsPerArm);
			expect(row.requests).toBe(
				DEFAULTS.trialsPerArm * DEFAULTS.probeHz * (DEFAULTS.warmS + DEFAULTS.postS)
			);
		}
		const small = estimate({ ...DEFAULTS, trialsPerArm: 2 });
		expect(small.totalDoRequests).toBeLessThan(full.totalDoRequests);
		expect(small.grossUsd).toBeLessThan(full.grossUsd);
		expect(full.totalDoRequests).toBe(full.arms.reduce((n, row) => n + row.doRequests, 0));
	});

	it('puts the hybrid between the two ends, and charges nothing above the included use at the defaults', () => {
		const [perRequest, lease, hybrid] = estimate(DEFAULTS).arms;
		expect(lease?.doRequests).toBeLessThan(hybrid?.doRequests ?? 0);
		expect(hybrid?.doRequests).toBeLessThan(perRequest?.doRequests ?? 0);
		expect(estimate(DEFAULTS).marginalUsd).toBe(0);
	});

	it('charges for the part above the included use', () => {
		const big = estimate({ ...DEFAULTS, trialsPerArm: 10_000 });
		expect(big.marginalUsd).toBeGreaterThan(0);
		expect(big.marginalUsd).toBeLessThan(big.grossUsd);
	});
});

describe('trial naming and classes', () => {
	it('gives each trial one site id that the contract accepts and one host', () => {
		const ids = new Set<string>();
		for (const arm of ARMS) {
			for (let n = 0; n < 10; n++) {
				const id = siteIdFor(arm, n);
				expect(id).toMatch(/^site_[0-9a-z]{8,40}$/);
				ids.add(id);
			}
		}
		expect(ids.size).toBe(30);
		expect(hostFor('{arm}-{n}.x.example', 'lease', 3)).toBe('lease-3.x.example');
	});

	it('marks every per-request trial strict, no lease trial, and a fraction of the hybrid', () => {
		const strict = (arm: (typeof ARMS)[number]) =>
			Array.from({ length: 10 }, (_, n) => isStrictTrial(arm, n, 10, 0.1)).filter(Boolean)
				.length;
		expect(strict('per-request')).toBe(10);
		expect(strict('lease')).toBe(0);
		expect(strict('hybrid')).toBe(1);
	});
});

describe('reading helpers', () => {
	it('reads the colo from the end of cf-ray', () => {
		expect(coloOf('8abc123def4567-ams')).toBe('AMS');
		expect(coloOf('8abc123def4567-AMS')).toBe('AMS');
		expect(coloOf('nope')).toBeNull();
		expect(coloOf(null)).toBeNull();
	});

	it('summarizes with n, quantiles and spread, and says null for nothing', () => {
		expect(summarize([5, 1, 3, 2, 4])).toEqual({
			n: 5,
			min: 1,
			p50: 3,
			p95: 5,
			max: 5,
			spread: 4
		});
		expect(summarize([])).toEqual({
			n: 0,
			min: null,
			p50: null,
			p95: null,
			max: null,
			spread: null
		});
		expect(quantile([], 0.5)).toBeNull();
	});

	it('measures from the commit ack to the last 2xx that finished after it', () => {
		const probe = (end: number, status: number) => ({
			start: end - 1,
			end,
			status,
			colo: null
		});
		const probes = [
			probe(90, 200),
			probe(105, 200),
			probe(130, 200),
			probe(140, 403),
			probe(150, 0)
		];
		expect(staleWindowMs(probes, 100)).toBe(30);
		expect(staleWindowMs([probe(90, 200), probe(120, 403)], 100)).toBe(0);
		expect(staleWindowMs([], 100)).toBe(0);
	});
});

describe('apply guard', () => {
	const all = [
		'--apply',
		'--host-template',
		'{n}.x.example',
		'--control-url',
		'https://c.example',
		'--control-host',
		'c.example'
	];

	it('lets a dry run through and refuses --apply without the confirmation', () => {
		expect(checkApply([], {})).toEqual({ ok: true });
		expect(checkApply(all, {})).toMatchObject({ ok: false });
		expect(checkApply(all, { SPIKE_CONFIRM: '0', SPIKE_CONTROL_SEED: 's' })).toMatchObject({
			ok: false
		});
	});

	it('refuses --apply without each required flag and the seed', () => {
		const env = { SPIKE_CONFIRM: '1', SPIKE_CONTROL_SEED: 's' };
		expect(checkApply(all, env)).toEqual({ ok: true });
		for (const flag of ['--host-template', '--control-url', '--control-host']) {
			const at = all.indexOf(flag);
			const without = all.filter((_, i) => i !== at && i !== at + 1);
			expect(checkApply(without, env)).toEqual({
				ok: false,
				reason: `--apply needs ${flag}`
			});
		}
		expect(checkApply(all, { SPIKE_CONFIRM: '1' })).toMatchObject({ ok: false });
	});
});
