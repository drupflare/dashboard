import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { AuthorityState } from '@contracts/site-auth';
import { scriptName } from '@contracts/sites';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import { resolveRoute } from '../../../dispatch/src/route';
import {
	certificateStatusOf,
	customHostnamesOf,
	D1DomainLedger,
	hostnameStatusOf,
	ProviderUnreachable
} from '../../../engine/src/adapters/domains';
import { hostsOf } from '../../../engine/src/adapters/hosts';
import { SiteUnreachable } from '../../../engine/src/adapters/site';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { CustomHostnames, CustomHostnameState, DomainDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import {
	planDomainAttach,
	releaseSiteDomains,
	runDomainAttach,
	type DomainAttachInput,
	type DomainRunner
} from '../../../engine/src/workflows/domain-attach';
import { planSiteDelete, runSiteDelete } from '../../../engine/src/workflows/site-delete';
import {
	isProven,
	readAttachState,
	viewOf,
	type CertificateStatus,
	type HostnameStatus
} from '../../../src/server/domain/domain-attach';
import { deriveChallenge, loadChallengeKeys } from '../../../src/shared/custody/challenge';
import { checkHostname, type DnsRecord } from '../../../src/shared/domain-copy';
import { failureReason } from '../../../src/shared/operation-copy';
import { fakeDns } from '../domain/dns-fakes';
import { Killed, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';

const HOST = 'www.example.edu';
const TARGET = 'edge.example.net';
const ACTIVE = {
	siteId: '',
	epoch: 1,
	generation: 1,
	state: 'active' as const,
	risk: 'new-free' as const,
	limits: { cpuMs: 50 },
	accessRuleHash: `sha256:${'0'.repeat(64)}` as const
};

function hostsKv() {
	const map = new Map<string, string>();
	const kv = {
		get: async (key: string) => map.get(key) ?? null,
		put: async (key: string, value: string) => void map.set(key, value),
		delete: async (key: string) => void map.delete(key)
	} as unknown as KVNamespace;
	return { kv, map };
}

interface Provider {
	status: HostnameStatus;
	ssl: CertificateStatus;
}

// the certificate service: one hostname per name, moved by the test the way the owner's DNS would
function fakeProvider() {
	const held = new Map<string, Provider & { id: string; hostname: string }>();
	const calls: string[] = [];
	let next = 1;
	let off: string | null = null;
	const refuseRemoval = new Set<string>();
	const recordsOf = (hostname: string): DnsRecord[] => [
		{
			purpose: 'certificate',
			type: 'TXT',
			name: `_cf-custom-hostname.${hostname}`,
			value: 'own-1'
		},
		{
			purpose: 'certificate',
			type: 'TXT',
			name: `_acme-challenge.${hostname}`,
			value: 'cert-1'
		},
		{ purpose: 'traffic', type: 'CNAME', name: hostname, value: TARGET }
	];
	const stateOf = (hostname: string): CustomHostnameState => {
		const row = held.get(hostname)!;
		return {
			providerId: row.id,
			observation: {
				hostnameStatus: row.status,
				certificateStatus: row.ssl,
				records: recordsOf(hostname)
			}
		};
	};
	const byId = (id: string) => [...held.values()].find((row) => row.id === id);
	const guard = () => {
		if (off !== null) throw new PermanentError('custom_domains_off', off);
	};
	const hostnames: CustomHostnames = {
		async ensure(hostname) {
			guard();
			calls.push(`ensure:${hostname}`);
			if (!held.has(hostname)) {
				held.set(hostname, {
					id: `cf_${next++}`,
					hostname,
					status: 'pending',
					ssl: 'pending'
				});
			}
			return stateOf(hostname);
		},
		async read(id) {
			guard();
			calls.push('read');
			const row = byId(id);
			return row === undefined ? null : stateOf(row.hostname);
		},
		async refresh(id) {
			guard();
			calls.push('refresh');
			const row = byId(id);
			if (row === undefined) throw new PermanentError('ownership_failed', 'gone');
			return stateOf(row.hostname);
		},
		async remove(id) {
			calls.push(`remove:${id}`);
			if (refuseRemoval.has(id)) {
				throw new PermanentError('custom_domains_refused', 'the provider refused');
			}
			const row = byId(id);
			if (row === undefined) return 'absent';
			held.delete(row.hostname);
			return 'deleted';
		}
	};
	return {
		hostnames,
		calls,
		held,
		set: (hostname: string, over: Partial<Provider>) => {
			const row = held.get(hostname);
			if (row !== undefined) Object.assign(row, over);
		},
		turnOff: (reason: string) => void (off = reason),
		turnOn: () => void (off = null),
		refuseRemoval: (id: string) => void refuseRemoval.add(id)
	};
}

type Dw = Awaited<ReturnType<typeof domainWorld>>;

const KEK = toBase64Url(new Uint8Array(32).fill(7));

async function domainWorld(over: { target?: string | null } = {}) {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const provider = fakeProvider();
	const dns = fakeDns();
	const keys = await loadChallengeKeys({ KEK_V1: KEK });
	const kv = hostsKv();
	const hosts = hostsOf(kv.kv);
	const answers = { value: false, probes: 0 };
	const now = () => world.clock.now();
	const orgB = `org_${'b'.repeat(26)}`;
	const siteB = `site_${'t'.repeat(26)}`;
	const deps: DomainDeps = {
		...world.deps,
		authority: {
			...world.deps.authority,
			putHost: hosts.put,
			deleteHostIfOwned: hosts.deleteIfOwned
		},
		site: {
			...world.deps.site,
			probe: async (hostname) => {
				answers.probes++;
				if (!answers.value) throw new SiteUnreachable(hostname, 'no answer');
				return { status: 200 };
			}
		},
		hostnames: provider.hostnames,
		domains: new D1DomainLedger(db, now),
		dns: dns.resolver,
		challenge: (input) => deriveChallenge(keys, input),
		target: over.target === undefined ? TARGET : over.target
	};
	const addSite = async (orgId: string, siteId: string, accountId: string) => {
		await world.store.activateSite(
			{
				id: siteId,
				organizationId: orgId,
				name: siteId,
				plane: 'managed',
				accountId,
				category: 'cms',
				config: 'managed'
			},
			now()
		);
		world.sqlite
			.prepare('UPDATE sites SET primary_hostname = ? WHERE id = ?')
			.run(`${siteId}.drupflare.app`, siteId);
		await world.authority.authority.apply({
			...ACTIVE,
			siteId: siteId as AuthorityState['siteId']
		});
	};
	await addSite(world.orgId, world.siteId, world.accountId);
	const dw = {
		world,
		deps,
		provider,
		dns,
		keys,
		kv,
		answers,
		orgB,
		siteB,
		accountB: 'b'.repeat(32),
		addSite,
		ops: 0
	};
	return dw;
}

function inputOf(dw: Dw, over: Partial<DomainAttachInput> = {}): DomainAttachInput {
	return {
		operationId: `op_${String.fromCharCode(97 + dw.ops)}${'d'.repeat(25)}`,
		orgId: dw.world.orgId,
		siteId: dw.world.siteId,
		accountId: dw.world.accountId,
		hostname: HOST,
		waitMs: 6 * 3_600_000,
		...over
	};
}

async function begin(dw: Dw, input: DomainAttachInput) {
	const frozen = await freezePlan(planDomainAttach(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: input.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		now: dw.world.clock.now()
	});
	await dw.world.store.begin({ operation, accountId: input.accountId, siteId: input.siteId });
}

interface Script extends RunnerScript {
	// stops before this step runs, the first time
	killBefore?: string;
	// runs at each sleep, with the number of sleeps so far
	onSleep?: (count: number) => void | Promise<void>;
	// shared by the attempts of one run that is killed and resumed, so the owner's timeline carries over
	counter?: { n: number };
}

function runnerFor(dw: Dw, memo: Memo, script: Script) {
	const { runner, executed } = makeRunner(memo, script);
	const counter = script.counter ?? { n: 0 };
	const domain: DomainRunner = {
		do: (name, fn) => {
			if (script.killBefore === name && !memo.has(name)) throw new Killed(executed.length);
			return runner.do(name, fn);
		},
		sleep: (name, ms) =>
			runner.do(name, async () => {
				dw.world.clock.advance(ms);
				counter.n++;
				await script.onSleep?.(counter.n);
			})
	};
	return { runner: domain, executed };
}

async function run(
	dw: Dw,
	options: {
		memo?: Memo;
		script?: Script;
		patch?: Partial<DomainAttachInput>;
		fresh?: boolean;
	} = {}
) {
	const input = inputOf(dw, options.patch);
	if (options.fresh !== false) await begin(dw, input);
	const { runner, executed } = runnerFor(dw, options.memo ?? new Map(), options.script ?? {});
	return { input, outcome: await runDomainAttach(runner, dw.deps, input), executed };
}

const operationOf = async (dw: Dw, input: DomainAttachInput) =>
	(await dw.world.store.get(input.operationId))!;

const stateOf = async (dw: Dw, input: DomainAttachInput) =>
	readAttachState((await operationOf(dw, input)).cursor)!;

const routeOf = (dw: Dw, host = HOST) => {
	const resolved = resolveRoute(host, dw.kv.map.get(host) ?? null);
	return resolved.ok ? resolved.value : null;
};

const claimOf = (dw: Dw, host = HOST) =>
	dw.world.sqlite.prepare('SELECT * FROM custom_domains WHERE hostname = ?').get(host) as
		| {
				organization_id: string;
				site_id: string;
				operation_id: string;
				epoch: number;
				state: string;
				provider_id: string | null;
				ownership_epoch: number | null;
		  }
		| undefined;

// the value the owner adds for the claim as it stands now
async function ownershipValue(dw: Dw, siteId = dw.world.siteId, host = HOST, epoch?: number) {
	const claim = claimOf(dw, host);
	return (
		await deriveChallenge(dw.keys, {
			siteId,
			hostname: host,
			epoch: epoch ?? claim?.epoch ?? 1
		})
	).value;
}

async function addOwnership(dw: Dw, siteId = dw.world.siteId, host = HOST, epoch?: number) {
	dw.dns.put(
		'TXT',
		`_drupflare-challenge.${host}`,
		`"${await ownershipValue(dw, siteId, host, epoch)}"`
	);
}

// the owner adds the ownership record after two checks, and the provider calls the hostname active and
// the certificate issued after the next; the address record lands after one more and the site
// answers after that
function owner(dw: Dw, host = HOST): Script['onSleep'] {
	return async (count) => {
		if (count === 2) await addOwnership(dw, dw.world.siteId, host);
		if (count === 3) dw.provider.set(host, { status: 'active', ssl: 'active' });
		if (count === 4) dw.dns.put('CNAME', host, `${TARGET}.`);
		if (count === 5) dw.answers.value = true;
	};
}

describe('attaching a domain', () => {
	it('plans one site and seven steps', () => {
		const plan = planDomainAttach({ siteId: 'site_a', hostname: HOST });
		expect(plan.type).toBe('domain.attach');
		expect(plan.targetIds).toEqual(['site_a']);
		expect(plan.blastRadius).toEqual({ sites: 1, destructiveSites: 0, productionDeploys: 0 });
		expect(plan.steps.map((step) => step.id)).toEqual([
			'lease',
			'claim',
			'ownership',
			'request',
			'certificate',
			'routing',
			'verification'
		]);
	});

	it('shows the four stages in order and routes only after the address record and the certificate', async () => {
		const dw = await domainWorld();
		const history: string[] = [];
		const input = inputOf(dw);
		const script: Script = {
			onSleep: async (count) => {
				await owner(dw)?.(count);
				const state = readAttachState((await operationOf(dw, input)).cursor)!;
				history.push(
					`${count}:${Object.values(state.stages).join(',')}:${routeOf(dw) === null ? 'unrouted' : 'routed'}`
				);
			}
		};
		const { outcome } = await run(dw, { script });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(history[0]).toBe('1:pending,waiting,waiting,waiting:unrouted');
		expect(history).toContain('2:pending,waiting,waiting,waiting:unrouted');
		expect(history).toContain('3:done,pending,waiting,waiting:unrouted');
		expect(history).toContain('4:done,done,pending,waiting:unrouted');
		expect(history).toContain('5:done,done,done,pending:routed');
		const state = await stateOf(dw, input);
		expect(Object.values(state.stages)).toEqual(['done', 'done', 'done', 'done']);
		expect(state.records.map((record) => record.purpose)).toEqual([
			'ownership',
			'traffic',
			'certificate',
			'certificate'
		]);
		const operation = await operationOf(dw, input);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.map((step) => step.state)).toEqual(Array(7).fill('succeeded'));
		expect(routeOf(dw)).toEqual({
			siteId: dw.world.siteId,
			script: expect.any(String),
			epoch: 1
		});
		expect(claimOf(dw)).toMatchObject({
			state: 'routed',
			epoch: 1,
			ownership_epoch: 1,
			site_id: dw.world.siteId
		});
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
	});

	it('shows the owner the ownership and routing records from the start, before the provider is asked', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		let early: DnsRecord[] = [];
		const { outcome } = await run(dw, {
			script: {
				onSleep: async (count) => {
					if (count === 1) {
						early = (await stateOf(dw, input)).records;
						expect(dw.provider.calls).toEqual([]);
					}
					await owner(dw)?.(count);
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		expect(early).toEqual([
			{
				purpose: 'ownership',
				type: 'TXT',
				name: `_drupflare-challenge.${HOST}`,
				value: await ownershipValue(dw)
			},
			{ purpose: 'traffic', type: 'CNAME', name: HOST, value: TARGET }
		]);
	});

	it('proves ownership with its own DNS check and asks the provider only after it passes', async () => {
		const dw = await domainWorld();
		let callsBeforeProof = -1;
		const { outcome } = await run(dw, {
			script: {
				onSleep: async (count) => {
					if (count === 2) callsBeforeProof = dw.provider.calls.length;
					await owner(dw)?.(count);
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		expect(callsBeforeProof).toBe(0);
		expect(dw.provider.calls[0]).toBe(`ensure:${HOST}`);
		expect(claimOf(dw)?.ownership_epoch).toBe(1);
	});

	it('does not take a value another site, hostname or epoch would carry as proof', async () => {
		const dw = await domainWorld();
		const rejected = [
			await ownershipValue(dw, dw.siteB, HOST, 1),
			await ownershipValue(dw, dw.world.siteId, 'example.edu', 1),
			await ownershipValue(dw, dw.world.siteId, HOST, 2)
		];
		dw.dns.put('TXT', `_drupflare-challenge.${HOST}`, ...rejected.map((value) => `"${value}"`));
		const { outcome, input } = await run(dw, { patch: { waitMs: 600_000 } });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('wait_timed_out');
		expect(dw.provider.calls).toEqual([]);
	});

	it('keeps waiting while the resolver is down and never fails the operation on it', async () => {
		const dw = await domainWorld();
		dw.dns.outage(true);
		const input = inputOf(dw);
		const { outcome } = await run(dw, {
			script: {
				onSleep: async (count) => {
					if (count === 3) {
						expect((await stateOf(dw, input)).stages.ownership).toBe('pending');
						expect((await stateOf(dw, input)).reason).toBeNull();
						dw.dns.outage(false);
					}
					if (count >= 3) await owner(dw)?.(count - 1);
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
	});

	it('waits at the final check until the site answers on the domain', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		const { outcome } = await run(dw, {
			script: {
				onSleep: async (count) => {
					await owner(dw)?.(count);
					if (count === 5) dw.answers.value = false;
					if (count === 8) dw.answers.value = true;
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		expect(dw.answers.probes).toBeGreaterThanOrEqual(4);
		expect((await stateOf(dw, input)).stages.verification).toBe('done');
	});

	it('gives up after the wait, closes the operation and takes back what it made', async () => {
		const dw = await domainWorld();
		const { outcome, input, executed } = await run(dw, { patch: { waitMs: 600_000 } });
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		const operation = await operationOf(dw, input);
		expect(operation.status).toBe('failed');
		expect(operation.steps.find((step) => step.id === 'ownership')?.state).toBe('failed');
		const state = await stateOf(dw, input);
		expect(state.reason).toBe('wait_timed_out');
		expect(
			failureReason({
				type: 'domain.attach',
				status: 'failed',
				failedStep: 'ownership',
				failedError: operation.steps.find((step) => step.id === 'ownership')?.error
			})
		).toMatch(/did not appear in time/);
		expect(dw.provider.held.size).toBe(0);
		expect(dw.provider.calls).toEqual([]);
		expect(claimOf(dw)).toMatchObject({
			state: 'released',
			provider_id: null,
			ownership_epoch: null
		});
		expect(routeOf(dw)).toBeNull();
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
		expect(executed.length).toBeLessThan(60);
	});

	it('lets the same site try again after a failure with a new epoch and a new value', async () => {
		const dw = await domainWorld();
		await addOwnership(dw);
		// the epoch 1 record proves the first claim, then the certificate never issues and it times out
		const first = await run(dw, { patch: { waitMs: 600_000 } });
		expect(first.outcome.status).toBe('failed');
		expect(claimOf(dw)).toMatchObject({ state: 'released', ownership_epoch: null });
		const oldValue = await ownershipValue(dw, dw.world.siteId, HOST, 1);
		dw.ops = 1;
		const input = inputOf(dw);
		const seen: string[] = [];
		const second = await run(dw, {
			script: {
				onSleep: async (count) => {
					// the epoch 1 value is still in DNS and must not count for epoch 2
					if (count === 1) seen.push((await stateOf(dw, input)).stages.ownership);
					await owner(dw)?.(count);
				}
			}
		});
		expect(seen).toEqual(['pending']);
		expect(await ownershipValue(dw)).not.toBe(oldValue);
		expect(second.outcome.status).toBe('succeeded');
		expect(claimOf(dw)).toMatchObject({ epoch: 2, state: 'routed', ownership_epoch: 2 });
	});

	it('fails the certificate stage when the provider drops the hostname', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			script: {
				onSleep: async (count) => {
					await owner(dw)?.(count);
					if (count === 3) dw.provider.set(HOST, { status: 'blocked' });
				}
			}
		});
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('custom_domains_refused');
		expect(claimOf(dw)?.state).toBe('released');
	});

	it('fails the certificate stage with its own reason', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			script: {
				onSleep: async (count) => {
					await owner(dw)?.(count);
					if (count === 3) dw.provider.set(HOST, { ssl: 'failed' });
				}
			}
		});
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('certificate_failed');
		expect(
			(await operationOf(dw, input)).steps.find((s) => s.id === 'certificate')?.state
		).toBe('failed');
	});

	it('waits for the address record before it routes, even when the provider says active', async () => {
		const dw = await domainWorld();
		const seen: (string | null)[] = [];
		const { outcome } = await run(dw, {
			script: {
				onSleep: async (count) => {
					await owner(dw)?.(count);
					if (count === 4) dw.dns.clear();
					if (count === 4) await addOwnership(dw);
					seen.push(routeOf(dw)?.siteId ?? null);
					if (count === 6) dw.dns.put('CNAME', HOST, `${TARGET}.`);
					if (count === 7) dw.answers.value = true;
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		expect(seen.slice(0, 5)).toEqual([null, null, null, null, null]);
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
	});

	it('fails the routing stage when the address record never lands', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			patch: { waitMs: 3_600_000 },
			script: {
				onSleep: async (count) => {
					if (count === 2) await addOwnership(dw);
					if (count === 3) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
				}
			}
		});
		expect(outcome.status).toBe('failed');
		const state = await stateOf(dw, input);
		expect(state.reason).toBe('wait_timed_out');
		expect(state.stages.routing).toBe('failed');
		expect(routeOf(dw)).toBeNull();
	});

	it('unwinds the route when the final check never passes', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			patch: { waitMs: 3_600_000 },
			script: {
				onSleep: async (count) => {
					if (count === 5) dw.answers.value = false;
					await owner(dw)?.(count);
					dw.answers.value = false;
				}
			}
		});
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('site_unreachable');
		expect(routeOf(dw)).toBeNull();
		expect(claimOf(dw)?.state).toBe('released');
		expect(dw.provider.held.size).toBe(0);
	});

	it('survives a kill at every few steps and ends with one hostname, one route and one claim', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		await begin(dw, input);
		const memo: Memo = new Map();
		const counter = { n: 0 };
		let outcome = null;
		for (let attempt = 0; attempt < 400 && outcome === null; attempt++) {
			try {
				const { runner } = runnerFor(dw, memo, {
					killAfter: 3,
					onSleep: owner(dw),
					counter
				});
				outcome = await runDomainAttach(runner, dw.deps, input);
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
		}
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(dw.provider.held.size).toBe(1);
		expect(dw.provider.calls.filter((call) => call.startsWith('ensure:'))).not.toHaveLength(0);
		expect(claimOf(dw)).toMatchObject({ state: 'routed', epoch: 1, ownership_epoch: 1 });
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
	});

	it('survives losing the answer of the request step after the provider created the hostname', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		await begin(dw, input);
		const memo: Memo = new Map();
		const counter = { n: 0 };
		// the ownership record is already in place, so the request step is the first outside call
		await addOwnership(dw);
		const first = runnerFor(dw, memo, { killDuring: 9, onSleep: owner(dw), counter });
		await expect(runDomainAttach(first.runner, dw.deps, input)).rejects.toBeInstanceOf(Killed);
		const again = runnerFor(dw, memo, { onSleep: owner(dw), counter });
		expect(await runDomainAttach(again.runner, dw.deps, input)).toEqual({
			status: 'succeeded'
		});
		expect(dw.provider.held.size).toBe(1);
	});
});

describe('a domain the provider cannot take yet', () => {
	it('ends waiting with ownership proven and the claim kept, not failed', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('Cloudflare for SaaS is not enabled for the zone');
		const { outcome, input } = await run(dw, { script: { onSleep: owner(dw) } });
		expect(outcome).toEqual({ status: 'waiting', reason: 'custom_domains_off' });
		const operation = await operationOf(dw, input);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('not-required');
		expect(operation.steps.map((step) => step.state)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'skipped',
			'skipped',
			'skipped',
			'skipped'
		]);
		const state = await stateOf(dw, input);
		expect(state.waiting).toBe('custom_domains_off');
		expect(state.reason).toBeNull();
		expect(Object.values(state.stages)).toEqual(['done', 'waiting', 'waiting', 'waiting']);
		expect(viewOf(input.operationId, state)).toMatchObject({
			status: 'waiting',
			reason: null,
			notice: expect.stringMatching(/Your domain is verified/)
		});
		expect(claimOf(dw)).toMatchObject({ state: 'claimed', epoch: 1, ownership_epoch: 1 });
		expect(routeOf(dw)).toBeNull();
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
		expect(dw.provider.held.size).toBe(0);
	});

	it('parks the same way when no target is configured and never calls the provider', async () => {
		const dw = await domainWorld({ target: null });
		const { outcome, input } = await run(dw, { script: { onSleep: owner(dw) } });
		expect(outcome.status).toBe('waiting');
		expect(dw.provider.calls).toEqual([]);
		expect((await stateOf(dw, input)).records.map((record) => record.purpose)).toEqual([
			'ownership'
		]);
	});

	it('does not park on a refusal that is not the feature being off', async () => {
		const dw = await domainWorld();
		dw.provider.hostnames.ensure = async () => {
			throw new PermanentError('custom_domains_refused', 'refused');
		};
		const { outcome, input } = await run(dw, { script: { onSleep: owner(dw) } });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('custom_domains_refused');
		expect(claimOf(dw)?.state).toBe('released');
	});

	it('tries again from the proof: no ownership check, same epoch, and it finishes', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('off');
		const first = await run(dw, { script: { onSleep: owner(dw) } });
		expect(first.outcome.status).toBe('waiting');
		// the record can go away now; the proof is the ledger's
		dw.dns.clear();
		dw.dns.asked.length = 0;
		dw.provider.turnOn();
		dw.ops = 1;
		let sleeps = 0;
		const second = await run(dw, {
			script: {
				onSleep: async (count) => {
					sleeps = count;
					if (count === 1) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
					if (count === 2) dw.dns.put('CNAME', HOST, `${TARGET}.`);
					if (count === 3) dw.answers.value = true;
				}
			}
		});
		expect(second.outcome.status).toBe('succeeded');
		expect(second.executed.some((name) => name.startsWith('ownership.poll'))).toBe(false);
		expect(second.executed.some((name) => name === 'ownership.wait.0')).toBe(false);
		expect(dw.dns.asked.some((entry) => entry.startsWith('TXT|_drupflare-challenge'))).toBe(
			false
		);
		expect(sleeps).toBe(3);
		const operation = await operationOf(dw, second.input);
		expect(operation.steps.map((step) => step.state)).toEqual(Array(7).fill('succeeded'));
		expect(claimOf(dw)).toMatchObject({
			state: 'routed',
			epoch: 1,
			ownership_epoch: 1,
			operation_id: second.input.operationId
		});
		expect((await stateOf(dw, second.input)).stages.ownership).toBe('done');
	});

	it('discards the proof when the claim is released, so the next epoch must be proven again', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('off');
		await run(dw, { script: { onSleep: owner(dw) } });
		const held = await dw.deps.domains.current(HOST);
		expect(isProven(held)).toBe(true);
		await dw.deps.domains.release(HOST, held!.epoch, dw.world.siteId);
		expect(isProven(await dw.deps.domains.current(HOST))).toBe(false);
		expect(claimOf(dw)).toMatchObject({ state: 'released', ownership_epoch: null });
		const again = await dw.deps.domains.claim(
			HOST,
			{ organizationId: dw.world.orgId, siteId: dw.world.siteId, operationId: 'op_again' },
			dw.world.clock.now()
		);
		expect(again).toMatchObject({ ok: true, epoch: 2 });
		expect(isProven(await dw.deps.domains.current(HOST))).toBe(false);
	});

	it('never lets another organisation inherit the proof, even with the old record still in DNS', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('off');
		await run(dw, { script: { onSleep: owner(dw) } });
		expect(claimOf(dw)?.ownership_epoch).toBe(1);
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('tombstoned', dw.world.siteId);
		await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		dw.ops = 1;
		const { outcome, input } = await run(dw, {
			patch: { orgId: dw.orgB, siteId: dw.siteB, accountId: dw.accountB, waitMs: 600_000 }
		});
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('wait_timed_out');
		expect(dw.provider.calls).toEqual([]);
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, ownership_epoch: null });
	});

	it('proves another organisation under its own value and then lets it finish', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('off');
		await run(dw, { script: { onSleep: owner(dw) } });
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('tombstoned', dw.world.siteId);
		await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		dw.provider.turnOn();
		dw.ops = 1;
		const { outcome } = await run(dw, {
			patch: { orgId: dw.orgB, siteId: dw.siteB, accountId: dw.accountB },
			script: {
				onSleep: async (count) => {
					if (count === 1) await addOwnership(dw, dw.siteB, HOST, 2);
					if (count === 2) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
					if (count === 3) dw.dns.put('CNAME', HOST, `${TARGET}.`);
					if (count === 4) dw.answers.value = true;
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, ownership_epoch: 2 });
	});
});

describe('which hostnames the workflow refuses', () => {
	it.each(['www.drupflare.app', 'drupflare.com', 'a.drupflare.com'])(
		'refuses %s before it claims or asks the provider',
		async (hostname) => {
			const dw = await domainWorld();
			const { outcome, input } = await run(dw, { patch: { hostname } });
			expect(outcome.status).toBe('failed');
			expect((await stateOf(dw, input)).reason).toBe('platform_zone');
			expect(dw.provider.calls).toEqual([]);
			expect(claimOf(dw, hostname)).toBeUndefined();
			expect(routeOf(dw, hostname)).toBeNull();
		}
	);

	it('refuses a name that is not a hostname', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, { patch: { hostname: '*.example.edu' } });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('wildcard');
	});

	it('refuses a site that is not live or that belongs to another organisation', async () => {
		const dw = await domainWorld();
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('suspended', dw.world.siteId);
		const stopped = await run(dw);
		expect(stopped.outcome.status).toBe('failed');
		expect((await stateOf(dw, stopped.input)).reason).toBe('site_not_ready');
		expect(claimOf(dw)).toBeUndefined();
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('active', dw.world.siteId);
		dw.ops = 1;
		const foreign = await run(dw, { patch: { orgId: dw.orgB } });
		// the operation belongs to the first organisation, so the second is refused at the store
		expect(foreign.outcome.status).toBe('failed');
		expect(claimOf(dw)).toBeUndefined();
	});

	it('fails when the key ring is missing, with a plain code and no claim kept', async () => {
		const dw = await domainWorld();
		dw.deps.challenge = async () => {
			throw new PermanentError('domain_checks_unavailable', 'no keys');
		};
		const { outcome, input } = await run(dw);
		expect(outcome.status).toBe('failed');
		expect((await operationOf(dw, input)).status).toBe('failed');
		expect(claimOf(dw)?.state).toBe('released');
	});
});

describe('a hostname that changes hands', () => {
	async function attached(dw: Dw) {
		const first = await run(dw, { script: { onSleep: owner(dw) } });
		expect(first.outcome.status).toBe('succeeded');
		return first;
	}

	async function secondOrganisation(dw: Dw) {
		await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		dw.ops = 1;
		return {
			orgId: dw.orgB,
			siteId: dw.siteB,
			accountId: dw.accountB
		};
	}

	it('refuses another organisation while the first site is live', async () => {
		const dw = await domainWorld();
		await attached(dw);
		const other = await secondOrganisation(dw);
		const before = dw.provider.calls.length;
		const { outcome, input } = await run(dw, { patch: other });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('hostname_taken');
		expect(dw.provider.calls.length).toBe(before);
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
		expect(claimOf(dw)).toMatchObject({ site_id: dw.world.siteId, epoch: 1, state: 'routed' });
	});

	it('never serves the old site once another organisation claims the hostname', async () => {
		const dw = await domainWorld();
		await attached(dw);
		const oldProvider = claimOf(dw)!.provider_id;
		expect(oldProvider).not.toBeNull();
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('tombstoned', dw.world.siteId);
		const other = await secondOrganisation(dw);
		const served: (string | null)[] = [];
		dw.dns.clear();
		dw.answers.value = false;
		const { outcome } = await run(dw, {
			patch: other,
			script: {
				onSleep: async (count) => {
					served.push(routeOf(dw)?.siteId ?? null);
					if (count === 1) await addOwnership(dw, dw.siteB, HOST, 2);
					if (count === 2) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
					if (count === 3) dw.dns.put('CNAME', HOST, `${TARGET}.`);
					if (count === 4) dw.answers.value = true;
				}
			}
		});
		expect(outcome.status).toBe('succeeded');
		// from the first wait on, the old site is gone and the new one is not routed yet
		expect(served[0]).toBeNull();
		expect(served).not.toContain(dw.world.siteId);
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
		expect(claimOf(dw)).toMatchObject({
			organization_id: dw.orgB,
			site_id: dw.siteB,
			epoch: 2,
			state: 'routed'
		});
		expect(claimOf(dw)!.provider_id).not.toBe(oldProvider);
		expect(dw.provider.calls).toContain(`remove:${oldProvider}`);
	});

	it('stops an old operation that resumes after the hostname moved on', async () => {
		const dw = await domainWorld();
		const memo: Memo = new Map();
		const first = inputOf(dw);
		await begin(dw, first);
		const paused = runnerFor(dw, memo, { killBefore: 'lease.routing', onSleep: owner(dw) });
		await expect(runDomainAttach(paused.runner, dw.deps, first)).rejects.toBeInstanceOf(Killed);
		expect(routeOf(dw)).toBeNull();
		expect(claimOf(dw)).toMatchObject({ epoch: 1, state: 'claimed' });

		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('deleted', dw.world.siteId);
		const other = await secondOrganisation(dw);
		dw.dns.clear();
		dw.answers.value = false;
		const second = await run(dw, {
			patch: other,
			script: {
				onSleep: async (count) => {
					if (count === 1) await addOwnership(dw, dw.siteB, HOST, 2);
					if (count === 2) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
					if (count === 3) dw.dns.put('CNAME', HOST, `${TARGET}.`);
					if (count === 4) dw.answers.value = true;
				}
			}
		});
		expect(second.outcome.status).toBe('succeeded');
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);

		const resumed = runnerFor(dw, memo, {});
		const outcome = await runDomainAttach(resumed.runner, dw.deps, first);
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, first)).reason).toBe('hostname_displaced');
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, state: 'routed' });
		expect(dw.provider.held.get(HOST)?.id).toBe(claimOf(dw)!.provider_id);
	});

	it('ends a waiting attach as cancelled, not displaced, when its owner gave the name up', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			script: {
				onSleep: async (count) => {
					if (count === 1) {
						dw.world.sqlite
							.prepare(
								"UPDATE custom_domains SET state = 'released', ownership_epoch = NULL WHERE hostname = ?"
							)
							.run(HOST);
					}
				}
			}
		});
		expect(outcome.status).toBe('failed');
		const state = await stateOf(dw, input);
		expect(state.reason).toBe('attach_cancelled');
		expect(viewOf(input.operationId, state).reason).toBe(
			'You cancelled this attach, so the name is no longer reserved for this site.'
		);
		expect(claimOf(dw)).toMatchObject({ state: 'released', ownership_epoch: null });
		expect(routeOf(dw)).toBeNull();
		expect(dw.provider.held.size).toBe(0);
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
	});

	it('refuses every ledger write that names an old epoch', async () => {
		const dw = await domainWorld();
		await attached(dw);
		dw.world.sqlite
			.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.run('tombstoned', dw.world.siteId);
		const other = await secondOrganisation(dw);
		const claim = await dw.deps.domains.claim(
			HOST,
			{ organizationId: other.orgId, siteId: other.siteId, operationId: 'op_other' },
			dw.world.clock.now()
		);
		expect(claim).toMatchObject({ ok: true, epoch: 2, providerId: null });
		expect(await dw.deps.domains.setProvider(HOST, 1, 'stale')).toBe(false);
		expect(await dw.deps.domains.proveOwnership(HOST, 1, dw.world.siteId)).toBe(false);
		expect(await dw.deps.domains.markRouted(HOST, 1, dw.world.siteId)).toBe(false);
		expect(await dw.deps.domains.release(HOST, 1, dw.world.siteId)).toBe(false);
		expect(claimOf(dw)).toMatchObject({
			site_id: dw.siteB,
			epoch: 2,
			state: 'claimed',
			ownership_epoch: null
		});
		expect(await dw.deps.domains.proveOwnership(HOST, 2, other.siteId)).toBe(true);
		expect(await dw.deps.domains.markRouted(HOST, 2, other.siteId)).toBe(true);
	});
});

describe('a claim that never proved the domain', () => {
	const HOLD = 72 * 3_600_000;

	// site A claims and then stops before it checks the domain, which is all a squatter ever does
	async function squatted(dw: Dw) {
		const memo: Memo = new Map();
		const first = inputOf(dw);
		await begin(dw, first);
		const paused = runnerFor(dw, memo, { killBefore: 'ownership.poll.0' });
		await expect(runDomainAttach(paused.runner, dw.deps, first)).rejects.toBeInstanceOf(Killed);
		expect(claimOf(dw)).toMatchObject({
			site_id: dw.world.siteId,
			epoch: 1,
			ownership_epoch: null
		});
		return { memo, first };
	}

	async function challenger(dw: Dw) {
		await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		dw.ops = 1;
		return { orgId: dw.orgB, siteId: dw.siteB, accountId: dw.accountB };
	}

	const who = (dw: Dw, siteId: string, operationId: string) => ({
		organizationId: siteId === dw.world.siteId ? dw.world.orgId : dw.orgB,
		siteId,
		operationId
	});

	const finishing = (dw: Dw): Script => ({
		onSleep: async (count) => {
			if (count === 1) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
			if (count === 2) dw.dns.put('CNAME', HOST, `${TARGET}.`);
			if (count === 3) dw.answers.value = true;
		}
	});

	it('lets a challenger with its own value take the name at the next epoch', async () => {
		const dw = await domainWorld();
		await squatted(dw);
		const other = await challenger(dw);
		await addOwnership(dw, dw.siteB, HOST, 2);
		const { outcome, input, executed } = await run(dw, {
			patch: other,
			script: finishing(dw)
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed).not.toContain('ownership.poll.0');
		expect(claimOf(dw)).toMatchObject({
			organization_id: dw.orgB,
			site_id: dw.siteB,
			epoch: 2,
			state: 'routed',
			ownership_epoch: 2
		});
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
		const state = await stateOf(dw, input);
		expect(state.stages.ownership).toBe('done');
	});

	it('never validates the displaced claim again, with its old record still in DNS', async () => {
		const dw = await domainWorld();
		const { memo, first } = await squatted(dw);
		await addOwnership(dw, dw.world.siteId, HOST, 1);
		const other = await challenger(dw);
		await addOwnership(dw, dw.siteB, HOST, 2);
		const second = await run(dw, { patch: other, script: finishing(dw) });
		expect(second.outcome.status).toBe('succeeded');
		const resumed = runnerFor(dw, memo, {});
		const outcome = await runDomainAttach(resumed.runner, dw.deps, first);
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, first)).reason).toBe('hostname_displaced');
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, state: 'routed' });
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
		expect(await dw.deps.domains.proveOwnership(HOST, 1, dw.world.siteId)).toBe(false);
		const old = await ownershipValue(dw, dw.world.siteId, HOST, 1);
		const next = await ownershipValue(dw, dw.world.siteId, HOST, 2);
		expect(old).not.toBe(next);
		expect(
			(await dw.deps.challenge({ siteId: dw.world.siteId, hostname: HOST, epoch: 2 }))
				.accepted
		).not.toContain(old);
	});

	it('refuses a challenger whose record is not there, and keeps the holder', async () => {
		const dw = await domainWorld();
		await squatted(dw);
		const other = await challenger(dw);
		const { outcome, input } = await run(dw, { patch: other });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('hostname_unproven');
		expect(claimOf(dw)).toMatchObject({ site_id: dw.world.siteId, epoch: 1 });
	});

	it('refuses a challenger that only carries the holder record or an old epoch', async () => {
		const dw = await domainWorld();
		await squatted(dw);
		await addOwnership(dw, dw.world.siteId, HOST, 2);
		await addOwnership(dw, dw.siteB, HOST, 1);
		const other = await challenger(dw);
		const { outcome, input } = await run(dw, { patch: other });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('hostname_unproven');
		expect(claimOf(dw)).toMatchObject({ site_id: dw.world.siteId, epoch: 1 });
	});

	it('refuses a challenger against a holder that proved, whatever it publishes', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('off');
		await run(dw, { script: { onSleep: owner(dw) } });
		expect(claimOf(dw)).toMatchObject({ epoch: 1, ownership_epoch: 1, state: 'claimed' });
		const other = await challenger(dw);
		await addOwnership(dw, dw.siteB, HOST, 2);
		const { outcome, input } = await run(dw, { patch: other });
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('hostname_taken');
		expect(claimOf(dw)).toMatchObject({
			site_id: dw.world.siteId,
			epoch: 1,
			ownership_epoch: 1
		});
	});

	it('removes the route and the provider hostname the displaced claim left behind', async () => {
		const dw = await domainWorld();
		await squatted(dw);
		dw.world.sqlite
			.prepare("UPDATE custom_domains SET provider_id = 'cf_old' WHERE hostname = ?")
			.run(HOST);
		await dw.deps.authority.putHost(HOST, { siteId: dw.world.siteId, script: 's', epoch: 1 });
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
		const other = await challenger(dw);
		await addOwnership(dw, dw.siteB, HOST, 2);
		const { outcome } = await run(dw, { patch: other, script: finishing(dw) });
		expect(outcome.status).toBe('succeeded');
		expect(dw.provider.calls).toContain('remove:cf_old');
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
	});

	describe('the ledger', () => {
		const proofOf =
			(answer: boolean, seen: number[] = []) =>
			async (epoch: number) => {
				seen.push(epoch);
				return answer;
			};

		async function held(dw: Dw) {
			const claim = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.world.siteId, 'op_a'),
				dw.world.clock.now()
			);
			expect(claim).toMatchObject({ ok: true, epoch: 1 });
			await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		}

		it('writes the takeover once, with the proof recorded and the old proof column cleared', async () => {
			const dw = await domainWorld();
			await held(dw);
			const seen: number[] = [];
			const claim = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now(),
				proofOf(true, seen)
			);
			expect(claim).toMatchObject({ ok: true, epoch: 2, providerId: null });
			expect(claim.ok && claim.previous?.siteId).toBe(dw.world.siteId);
			expect(seen).toEqual([2]);
			expect(claimOf(dw)).toMatchObject({
				organization_id: dw.orgB,
				site_id: dw.siteB,
				operation_id: 'op_b',
				epoch: 2,
				state: 'claimed',
				ownership_epoch: 2
			});
			expect(isProven(await dw.deps.domains.current(HOST))).toBe(true);
		});

		it('refuses with no proof callback and with a proof that fails, and changes nothing', async () => {
			const dw = await domainWorld();
			await held(dw);
			const before = claimOf(dw);
			const none = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now()
			);
			expect(none).toEqual({ ok: false });
			const failed = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now(),
				proofOf(false)
			);
			expect(failed).toEqual({ ok: false, unproven: true });
			expect(claimOf(dw)).toEqual(before);
		});

		it('never asks for proof against a holder that proved', async () => {
			const dw = await domainWorld();
			await held(dw);
			await dw.deps.domains.proveOwnership(HOST, 1, dw.world.siteId);
			const seen: number[] = [];
			const claim = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now(),
				proofOf(true, seen)
			);
			expect(claim).toEqual({ ok: false });
			expect(seen).toEqual([]);
			expect(claimOf(dw)).toMatchObject({ site_id: dw.world.siteId, ownership_epoch: 1 });
		});

		it('loses the race when the holder proves while the challenger is being checked', async () => {
			const dw = await domainWorld();
			await held(dw);
			const claim = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now(),
				async () => {
					expect(await dw.deps.domains.proveOwnership(HOST, 1, dw.world.siteId)).toBe(
						true
					);
					return true;
				}
			);
			expect(claim).toEqual({ ok: false });
			expect(claimOf(dw)).toMatchObject({
				site_id: dw.world.siteId,
				epoch: 1,
				ownership_epoch: 1
			});
		});

		it('loses the race when another claim moves the epoch first, so there is never a second owner', async () => {
			const dw = await domainWorld();
			await held(dw);
			const claim = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				dw.world.clock.now(),
				async () => {
					dw.world.sqlite
						.prepare(
							"UPDATE custom_domains SET epoch = 2, site_id = 'site_other' WHERE hostname = ?"
						)
						.run(HOST);
					return true;
				}
			);
			expect(claim).toEqual({ ok: false });
			expect(claimOf(dw)).toMatchObject({ site_id: 'site_other', epoch: 2 });
		});

		it('stops holding an unproven name 72 hours after the claim, just before and just after', async () => {
			const dw = await domainWorld();
			await held(dw);
			const t0 = dw.world.clock.now();
			const seen: number[] = [];
			const before = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				t0 + HOLD - 1,
				proofOf(false, seen)
			);
			expect(before).toEqual({ ok: false, unproven: true });
			expect(seen).toEqual([2]);
			const after = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.siteB, 'op_b'),
				t0 + HOLD,
				proofOf(false, seen)
			);
			expect(after).toMatchObject({ ok: true, epoch: 2 });
			expect(seen).toEqual([2]);
			expect(claimOf(dw)).toMatchObject({
				site_id: dw.siteB,
				epoch: 2,
				ownership_epoch: null
			});
		});

		it('does not expire a claim that proved, and refuses to expire one that proves in the race', async () => {
			const dw = await domainWorld();
			await held(dw);
			await dw.deps.domains.proveOwnership(HOST, 1, dw.world.siteId);
			const late = dw.world.clock.now() + 10 * HOLD;
			expect(
				await dw.deps.domains.claim(HOST, who(dw, dw.siteB, 'op_b'), late, proofOf(true))
			).toEqual({ ok: false });
			expect(claimOf(dw)).toMatchObject({ site_id: dw.world.siteId });
		});

		it('leaves a claim made without a proof callback exactly as it was, however old', async () => {
			const dw = await domainWorld();
			await held(dw);
			const late = dw.world.clock.now() + 10 * HOLD;
			expect(await dw.deps.domains.claim(HOST, who(dw, dw.siteB, 'op_b'), late)).toEqual({
				ok: false
			});
		});

		it('keeps the claim for the same site, and sends another site of the same organisation to the proof', async () => {
			const dw = await domainWorld();
			await held(dw);
			const again = await dw.deps.domains.claim(
				HOST,
				who(dw, dw.world.siteId, 'op_again'),
				dw.world.clock.now(),
				proofOf(false)
			);
			expect(again).toMatchObject({ ok: true, epoch: 1, previous: null });
			expect(claimOf(dw)).toMatchObject({ operation_id: 'op_again', epoch: 1 });
			const sibling = await dw.deps.domains.claim(
				HOST,
				{ organizationId: dw.world.orgId, siteId: dw.siteB, operationId: 'op_sib' },
				dw.world.clock.now(),
				proofOf(false)
			);
			expect(sibling).toEqual({ ok: false, unproven: true });
		});
	});
});

describe("releasing a site's domains", () => {
	async function twoDomains(dw: Dw) {
		const hosts = ['www.example.edu', 'news.example.edu'];
		for (const [index, host] of hosts.entries()) {
			dw.dns.clear();
			dw.answers.value = false;
			dw.ops = index;
			const done = await run(dw, {
				patch: { hostname: host },
				script: {
					onSleep: async (count) => {
						if (count === 2) await addOwnership(dw, dw.world.siteId, host);
						if (count === 3) dw.provider.set(host, { status: 'active', ssl: 'active' });
						if (count === 4) dw.dns.put('CNAME', host, `${TARGET}.`);
						if (count === 5) dw.answers.value = true;
					}
				}
			});
			expect(done.outcome.status).toBe('succeeded');
		}
		return hosts;
	}

	it('removes the route, the provider hostname and the claim of each, and does the same twice', async () => {
		const dw = await domainWorld();
		const hosts = await twoDomains(dw);
		const first = await releaseSiteDomains(dw.deps, dw.world.siteId);
		expect(first).toEqual({ released: [...hosts].sort(), failed: [] });
		for (const host of hosts) {
			expect(routeOf(dw, host)).toBeNull();
			expect(claimOf(dw, host)).toMatchObject({ state: 'released', ownership_epoch: null });
		}
		expect(dw.provider.held.size).toBe(0);
		expect(await releaseSiteDomains(dw.deps, dw.world.siteId)).toEqual({
			released: [],
			failed: []
		});
	});

	it('reports a hostname the provider will not remove and keeps its claim for a later run', async () => {
		const dw = await domainWorld();
		const hosts = await twoDomains(dw);
		const stuck = claimOf(dw, hosts[1])!.provider_id!;
		dw.provider.refuseRemoval(stuck);
		const result = await releaseSiteDomains(dw.deps, dw.world.siteId);
		expect(result.failed).toEqual([hosts[1]]);
		expect(result.released).toEqual([hosts[0]]);
		expect(claimOf(dw, hosts[1])).toMatchObject({ state: 'routed', provider_id: stuck });
		expect(routeOf(dw, hosts[1])).toBeNull();
		expect(claimOf(dw, hosts[0])?.state).toBe('released');
	});

	it('leaves a hostname alone that now belongs to another site', async () => {
		const dw = await domainWorld();
		await twoDomains(dw);
		await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
		const result = await releaseSiteDomains(dw.deps, dw.siteB);
		expect(result).toEqual({ released: [], failed: [] });
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
	});

	it('runs when the site is deleted and says which domain the provider kept', async () => {
		const dw = await domainWorld();
		const hosts = await twoDomains(dw);
		dw.provider.refuseRemoval(claimOf(dw, hosts[0])!.provider_id!);
		const operationId = `op_${'x'.repeat(26)}`;
		const frozen = await freezePlan(planSiteDelete({ siteId: dw.world.siteId }));
		await dw.world.store.begin({
			operation: newOperation({
				id: operationId,
				orgId: dw.world.orgId,
				idempotencyKey: 'key-delete',
				frozen,
				verification: 'not-required',
				now: dw.world.clock.now()
			}),
			accountId: dw.world.accountId,
			siteId: dw.world.siteId
		});
		const outcome = await runSiteDelete(makeRunner(new Map()).runner, dw.deps, {
			operationId,
			siteId: dw.world.siteId,
			accountId: dw.world.accountId,
			hostnames: []
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		const operation = (await dw.world.store.get(operationId))!;
		expect(operation.finalObservation?.summary).toContain(hosts[0]);
		expect(claimOf(dw, hosts[1])?.state).toBe('released');
		expect(claimOf(dw, hosts[0])?.state).toBe('routed');
	});

	describe('when the site holds a proven, a waiting and a released domain', () => {
		const PROVEN = 'www.example.edu';
		const WAITING = 'news.example.edu';
		const GONE = 'old.example.edu';
		const DELETE_OP = `op_${'d'.repeat(26)}`;

		async function seed(dw: Dw) {
			const siteId = dw.world.siteId;
			const claim = async (host: string, operationId: string) => {
				const answer = await dw.deps.domains.claim(
					host,
					{ organizationId: dw.world.orgId, siteId, operationId },
					dw.world.clock.now()
				);
				expect(answer).toMatchObject({ ok: true, epoch: 1 });
			};
			await claim(PROVEN, 'op_proven');
			const state = await dw.deps.hostnames.ensure(PROVEN);
			await dw.deps.domains.setProvider(PROVEN, 1, state.providerId);
			await dw.deps.domains.proveOwnership(PROVEN, 1, siteId);
			await dw.deps.domains.markRouted(PROVEN, 1, siteId);
			await dw.deps.authority.putHost(PROVEN, {
				siteId,
				script: scriptName(siteId),
				epoch: 1
			});
			await claim(WAITING, 'op_waiting');
			await claim(GONE, 'op_gone');
			await dw.deps.domains.release(GONE, 1, siteId);
		}

		async function startDelete(dw: Dw, operationId = DELETE_OP) {
			const operation = newOperation({
				id: operationId,
				orgId: dw.world.orgId,
				idempotencyKey: `key-${operationId}`,
				frozen: await freezePlan(planSiteDelete({ siteId: dw.world.siteId })),
				verification: 'not-required',
				now: dw.world.clock.now()
			});
			await dw.world.store.begin({
				operation,
				accountId: dw.world.accountId,
				siteId: dw.world.siteId
			});
		}

		const deleteInput = (dw: Dw, operationId = DELETE_OP) => ({
			operationId,
			siteId: dw.world.siteId,
			accountId: dw.world.accountId,
			hostnames: [] as string[]
		});

		async function deleteSite(
			dw: Dw,
			over: {
				deps?: DomainDeps;
				memo?: Memo;
				script?: RunnerScript;
				operationId?: string;
			} = {}
		) {
			await startDelete(dw, over.operationId);
			return runSiteDelete(
				makeRunner(over.memo ?? new Map(), over.script).runner,
				over.deps ?? dw.deps,
				deleteInput(dw, over.operationId)
			);
		}

		const rowsOf = (dw: Dw) =>
			[PROVEN, WAITING, GONE].map((host) => {
				const row = claimOf(dw, host)!;
				return [host, row.state, row.epoch, row.provider_id, row.ownership_epoch];
			});

		const snapshot = async (dw: Dw) => ({
			rows: rowsOf(dw),
			kv: [...dw.kv.map.entries()],
			provider: [...dw.provider.held.keys()],
			site: await dw.world.store.siteState(dw.world.siteId)
		});

		it('takes the provider hostname, the route and the claim of each, and clears the proof', async () => {
			const dw = await domainWorld();
			await seed(dw);
			const providerId = claimOf(dw, PROVEN)!.provider_id!;
			expect(routeOf(dw, PROVEN)?.siteId).toBe(dw.world.siteId);
			expect(await deleteSite(dw)).toEqual({ status: 'succeeded' });
			expect(dw.provider.calls).toContain(`remove:${providerId}`);
			expect(dw.provider.calls.filter((call) => call.startsWith('remove:'))).toHaveLength(1);
			expect(dw.provider.held.size).toBe(0);
			expect(routeOf(dw, PROVEN)).toBeNull();
			expect(rowsOf(dw)).toEqual([
				[PROVEN, 'released', 1, null, null],
				[WAITING, 'released', 1, null, null],
				[GONE, 'released', 1, null, null]
			]);
			expect(await dw.world.store.siteState(dw.world.siteId)).toBe('tombstoned');
		});

		it('leaves a route that another site owns, and still releases the claim', async () => {
			const dw = await domainWorld();
			await seed(dw);
			dw.kv.map.set(
				GONE,
				JSON.stringify({ v: 1, siteId: dw.siteB, script: scriptName(dw.siteB), epoch: 1 })
			);
			await deleteSite(dw);
			expect(routeOf(dw, GONE)?.siteId).toBe(dw.siteB);
			expect(routeOf(dw, PROVEN)).toBeNull();
			expect(claimOf(dw, PROVEN)?.state).toBe('released');
		});

		it('moves a released name to the next challenger under a higher epoch, so the old record proves nothing', async () => {
			const dw = await domainWorld();
			await seed(dw);
			await addOwnership(dw, dw.world.siteId, PROVEN, 1);
			await deleteSite(dw);
			await dw.addSite(dw.orgB, dw.siteB, dw.accountB);
			dw.ops = 1;
			let seen: ReturnType<typeof claimOf>;
			const { outcome } = await run(dw, {
				patch: {
					hostname: PROVEN,
					orgId: dw.orgB,
					siteId: dw.siteB,
					accountId: dw.accountB,
					waitMs: 3_600_000
				},
				script: {
					onSleep: (count) => {
						if (count === 1) seen = claimOf(dw, PROVEN);
					}
				}
			});
			expect(seen).toMatchObject({ site_id: dw.siteB, epoch: 2, ownership_epoch: null });
			expect(outcome.status).toBe('failed');
			expect(claimOf(dw, PROVEN)).toMatchObject({ state: 'released', epoch: 2 });
		});

		it('lets the same site claim a released name again under a higher epoch', async () => {
			const dw = await domainWorld();
			await seed(dw);
			await deleteSite(dw);
			const again = await dw.deps.domains.claim(
				GONE,
				{ organizationId: dw.world.orgId, siteId: dw.world.siteId, operationId: 'op_back' },
				dw.world.clock.now()
			);
			expect(again).toMatchObject({ ok: true, epoch: 2 });
			expect(claimOf(dw, GONE)).toMatchObject({ state: 'claimed', ownership_epoch: null });
		});

		describe('when a step fails', () => {
			const flaky = (dw: Dw, failures: { remove?: number; route?: number }) => {
				const left = { remove: failures.remove ?? 0, route: failures.route ?? 0 };
				const deps: DomainDeps = {
					...dw.deps,
					hostnames: {
						...dw.deps.hostnames,
						remove: async (id) => {
							if (left.remove-- > 0) throw new ProviderUnreachable('down');
							return dw.provider.hostnames.remove(id);
						}
					},
					authority: {
						...dw.deps.authority,
						deleteHostIfOwned: async (host, siteId) => {
							if (left.route-- > 0) throw new Error('the route store did not answer');
							return dw.deps.authority.deleteHostIfOwned(host, siteId);
						}
					}
				};
				return deps;
			};

			it('keeps the claim when the provider does not answer, and a second delete finishes it', async () => {
				const dw = await domainWorld();
				await seed(dw);
				const deps = flaky(dw, { remove: 1 });
				expect((await deleteSite(dw, { deps })).status).toBe('failed');
				expect(claimOf(dw, PROVEN)).toMatchObject({ state: 'routed', ownership_epoch: 1 });
				expect(routeOf(dw, PROVEN)).toBeNull();
				expect(dw.provider.held.size).toBe(1);
				expect(await dw.world.store.siteState(dw.world.siteId)).not.toBe('tombstoned');
				const again = await deleteSite(dw, { deps, operationId: `op_${'e'.repeat(26)}` });
				expect(again).toEqual({ status: 'succeeded' });
				expect(dw.provider.held.size).toBe(0);
				expect(claimOf(dw, PROVEN)).toMatchObject({
					state: 'released',
					ownership_epoch: null
				});
			});

			it('rides out a short provider outage inside the step when it retries', async () => {
				const dw = await domainWorld();
				await seed(dw);
				const deps = flaky(dw, { remove: 2 });
				expect(await deleteSite(dw, { deps, script: { retries: 2 } })).toEqual({
					status: 'succeeded'
				});
				expect(dw.provider.held.size).toBe(0);
				expect(rowsOf(dw).map((row) => row[1])).toEqual([
					'released',
					'released',
					'released'
				]);
			});

			it('leaves the provider hostname alone when the route store fails first, and finishes on a second delete', async () => {
				const dw = await domainWorld();
				await seed(dw);
				const deps = flaky(dw, { route: 1 });
				expect((await deleteSite(dw, { deps })).status).toBe('failed');
				expect(dw.provider.held.size).toBe(1);
				expect(routeOf(dw, PROVEN)?.siteId).toBe(dw.world.siteId);
				expect(claimOf(dw, PROVEN)?.state).toBe('routed');
				const again = await deleteSite(dw, { deps, operationId: `op_${'e'.repeat(26)}` });
				expect(again).toEqual({ status: 'succeeded' });
				expect(routeOf(dw, PROVEN)).toBeNull();
				expect(dw.provider.held.size).toBe(0);
			});
		});

		it('ends in the same state when killed after or during any step and run again', async () => {
			const reference = await domainWorld();
			await seed(reference);
			await startDelete(reference);
			const first = makeRunner(new Map());
			await runSiteDelete(first.runner, reference.deps, deleteInput(reference));
			const expected = await snapshot(reference);
			for (let k = 0; k < first.executed.length; k++) {
				for (const kind of ['killAfter', 'killDuring'] as const) {
					const dw = await domainWorld();
					await seed(dw);
					await startDelete(dw);
					const memo: Memo = new Map();
					const script = kind === 'killAfter' ? { killAfter: k } : { killDuring: k + 1 };
					await expect(
						runSiteDelete(makeRunner(memo, script).runner, dw.deps, deleteInput(dw))
					).rejects.toBeInstanceOf(Killed);
					const outcome = await runSiteDelete(
						makeRunner(memo).runner,
						dw.deps,
						deleteInput(dw)
					);
					expect(outcome, `${kind} ${k}`).toEqual({ status: 'succeeded' });
					expect(await snapshot(dw), `${kind} ${k}`).toEqual(expected);
				}
			}
		});
	});
});

describe('the certificate service adapter', () => {
	const reply = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	function client(handler: (request: Request) => Response | Promise<Response>) {
		const seen: { method: string; url: string; body: unknown; authorization: string | null }[] =
			[];
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(String(input), init);
			const text = await request.clone().text();
			seen.push({
				method: request.method,
				url: request.url,
				body: text === '' ? null : JSON.parse(text),
				authorization: request.headers.get('authorization')
			});
			return handler(request);
		}) as typeof fetch;
		return {
			seen,
			hostnames: customHostnamesOf({
				fetch: fetcher,
				token: 'tok_secret',
				zoneId: 'zone_1',
				target: TARGET,
				timeoutMs: 1000
			})
		};
	}

	const result = (over: object = {}) => ({
		id: 'cf_9',
		hostname: HOST,
		status: 'pending',
		ssl: {
			status: 'pending_validation',
			validation_records: [{ txt_name: `_acme-challenge.${HOST}`, txt_value: 'cert-9' }]
		},
		ownership_verification: {
			type: 'txt',
			name: `_cf-custom-hostname.${HOST}`,
			value: 'own-9'
		},
		...over
	});

	it('creates a hostname with TXT validation when none exists and lists the three records', async () => {
		const { seen, hostnames } = client((request) =>
			request.method === 'GET'
				? reply(200, { success: true, result: [] })
				: reply(200, { success: true, result: result() })
		);
		const state = await hostnames.ensure(HOST);
		expect(seen.map((call) => call.method)).toEqual(['GET', 'POST']);
		expect(seen[0]!.url).toContain('/zones/zone_1/custom_hostnames?hostname=www.example.edu');
		expect(seen[1]!.body).toMatchObject({ hostname: HOST, ssl: { method: 'txt', type: 'dv' } });
		expect(seen.every((call) => call.authorization === 'Bearer tok_secret')).toBe(true);
		expect(state.providerId).toBe('cf_9');
		expect(state.observation).toEqual({
			hostnameStatus: 'pending',
			certificateStatus: 'pending',
			records: [
				{
					purpose: 'certificate',
					type: 'TXT',
					name: `_cf-custom-hostname.${HOST}`,
					value: 'own-9'
				},
				{
					purpose: 'certificate',
					type: 'TXT',
					name: `_acme-challenge.${HOST}`,
					value: 'cert-9'
				},
				{ purpose: 'traffic', type: 'CNAME', name: HOST, value: TARGET }
			]
		});
	});

	it('finds an existing hostname instead of creating a second one', async () => {
		const { seen, hostnames } = client(() => reply(200, { success: true, result: [result()] }));
		expect((await hostnames.ensure(HOST)).providerId).toBe('cf_9');
		expect(seen.map((call) => call.method)).toEqual(['GET']);
	});

	it('reads, refreshes and removes, and treats a missing hostname as absent', async () => {
		const missing = client(() => new Response('', { status: 404 }));
		expect(await missing.hostnames.read('cf_9')).toBeNull();
		expect(await missing.hostnames.remove('cf_9')).toBe('absent');
		await expect(missing.hostnames.refresh('cf_9')).rejects.toMatchObject({
			code: 'ownership_failed'
		});
		const live = client(() =>
			reply(200, { success: true, result: result({ status: 'active' }) })
		);
		expect((await live.hostnames.read('cf_9'))?.observation.hostnameStatus).toBe('active');
		await live.hostnames.refresh('cf_9');
		expect(live.seen[1]!.method).toBe('PATCH');
		expect(live.seen[1]!.body).toEqual({
			ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } }
		});
		expect(await live.hostnames.remove('cf_9')).toBe('deleted');
	});

	it.each([401, 403])(
		'refuses plainly on %s and names both ways it can happen',
		async (status) => {
			const { hostnames } = client(() => reply(status, { success: false, errors: [] }));
			const error = await hostnames.ensure(HOST).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(PermanentError);
			expect((error as PermanentError).code).toBe('custom_domains_off');
			expect((error as Error).message).toMatch(/Cloudflare for SaaS/);
			expect((error as Error).message).not.toContain('tok_secret');
		}
	);

	it.each([
		[400, 1404],
		[403, 1456],
		[200, 1404]
	])('reads status %s with code %s as the feature being off', async (status, code) => {
		const { hostnames } = client(() =>
			reply(status, { success: false, errors: [{ code, message: 'no quota' }] })
		);
		const error = await hostnames.ensure(HOST).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(PermanentError);
		expect((error as PermanentError).code).toBe('custom_domains_off');
		expect((error as Error).message).toContain(String(code));
		expect((error as Error).message).not.toContain('tok_secret');
	});

	it('reads a 400 with another code as a refusal, not as the feature being off', async () => {
		const { hostnames } = client(() =>
			reply(400, { success: false, errors: [{ code: 1406, message: 'bad hostname' }] })
		);
		await expect(hostnames.ensure(HOST)).rejects.toMatchObject({
			code: 'custom_domains_refused'
		});
	});

	it('refuses plainly with no zone or no target and never calls out', async () => {
		let called = 0;
		const fetcher = (async () => {
			called++;
			return reply(200, {});
		}) as typeof fetch;
		for (const options of [
			{ zoneId: undefined, target: TARGET },
			{ zoneId: 'zone_1', target: undefined },
			{ zoneId: '', target: '' }
		]) {
			const hostnames = customHostnamesOf({
				fetch: fetcher,
				token: 't',
				timeoutMs: 1,
				...options
			});
			await expect(hostnames.ensure(HOST)).rejects.toMatchObject({
				code: 'custom_domains_off'
			});
		}
		expect(called).toBe(0);
	});

	it('retries a busy or unreachable service and refuses any other 4xx for good', async () => {
		const busy = client(() => reply(429, {}));
		await expect(busy.hostnames.ensure(HOST)).rejects.toBeInstanceOf(ProviderUnreachable);
		const down = client(() => reply(503, {}));
		await expect(down.hostnames.ensure(HOST)).rejects.toBeInstanceOf(ProviderUnreachable);
		const dead = customHostnamesOf({
			fetch: (async () => {
				throw new Error('socket closed');
			}) as typeof fetch,
			token: 't',
			zoneId: 'z',
			target: TARGET,
			timeoutMs: 1
		});
		await expect(dead.ensure(HOST)).rejects.toBeInstanceOf(ProviderUnreachable);
		const bad = client(() => reply(400, { errors: [{ code: 1406, message: 'duplicate' }] }));
		const error = await bad.hostnames.ensure(HOST).catch((cause: unknown) => cause);
		expect((error as PermanentError).code).toBe('custom_domains_refused');
		expect((error as Error).message).toContain('1406');
	});

	it('reads the provider status words by name', () => {
		expect(
			['active', 'active_redeploying', 'moved', 'pending_deletion', 'blocked', 'pending'].map(
				hostnameStatusOf
			)
		).toEqual(['active', 'active', 'moved', 'deleted', 'blocked', 'pending']);
		expect(
			[undefined, 'active', 'pending_validation', 'validation_timed_out', 'expired'].map(
				certificateStatusOf
			)
		).toEqual(['none', 'active', 'pending', 'failed', 'failed']);
	});

	it('is the same check the page runs', () => {
		expect(checkHostname(HOST)).toMatchObject({ ok: true });
	});
});
