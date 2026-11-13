import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { AuthorityState } from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
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
	runDomainAttach,
	type DomainAttachInput,
	type DomainRunner
} from '../../../engine/src/workflows/domain-attach';
import {
	readAttachState,
	type CertificateStatus,
	type HostnameStatus
} from '../../../src/server/domain/domain-attach';
import { checkHostname, type DnsRecord } from '../../../src/shared/domain-copy';
import { failureReason } from '../../../src/shared/operation-copy';
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
	const recordsOf = (hostname: string): DnsRecord[] => [
		{
			purpose: 'ownership',
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
		turnOff: (reason: string) => void (off = reason)
	};
}

type Dw = Awaited<ReturnType<typeof domainWorld>>;

async function domainWorld() {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const provider = fakeProvider();
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
		domains: new D1DomainLedger(db, now)
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
		  }
		| undefined;

// the owner adds the ownership record after two checks, the certificate after four, the address after six
function owner(dw: Dw, host = HOST): Script['onSleep'] {
	return (count) => {
		if (count === 2) dw.provider.set(host, { status: 'active' });
		if (count === 4) dw.provider.set(host, { ssl: 'active' });
		if (count === 6) dw.answers.value = true;
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
			'request',
			'ownership',
			'certificate',
			'routing',
			'verification'
		]);
	});

	it('shows the four stages in order and routes only after the certificate', async () => {
		const dw = await domainWorld();
		const history: string[] = [];
		const input = inputOf(dw);
		const script: Script = {
			onSleep: async (count) => {
				owner(dw)?.(count);
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
		expect(history).toContain('5:done,done,done,pending:routed');
		const state = await stateOf(dw, input);
		expect(Object.values(state.stages)).toEqual(['done', 'done', 'done', 'done']);
		expect(state.records.map((record) => record.purpose)).toEqual([
			'ownership',
			'certificate',
			'traffic'
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
		expect(claimOf(dw)).toMatchObject({ state: 'routed', epoch: 1, site_id: dw.world.siteId });
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
	});

	it('does not route while the certificate says active and the ownership check is open', async () => {
		const dw = await domainWorld();
		const script: Script = {
			onSleep: (count) => {
				if (count === 1) dw.provider.set(HOST, { ssl: 'active' });
				if (count === 3) {
					expect(routeOf(dw)).toBeNull();
					dw.provider.set(HOST, { status: 'active' });
				}
				if (count === 4) dw.answers.value = true;
			}
		};
		const input = inputOf(dw);
		const { outcome } = await run(dw, { script });
		expect(outcome.status).toBe('succeeded');
		expect(routeOf(dw)).not.toBeNull();
		expect((await stateOf(dw, input)).stages.ownership).toBe('done');
	});

	it('waits at the final check until the site answers on the domain', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		// the hostname exists only after the request, so the owner's records land on the first sleep
		const { outcome } = await run(dw, {
			script: {
				onSleep: (count) => {
					if (count === 1) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
					if (count === 5) dw.answers.value = true;
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
		expect(claimOf(dw)).toMatchObject({ state: 'released', provider_id: null });
		expect(routeOf(dw)).toBeNull();
		expect(dw.world.leases.stateOf(dw.world.siteId)).toMatchObject({ holder: null });
		expect(executed.length).toBeLessThan(60);
	});

	it('lets the same site try again after a failure and counts a new epoch', async () => {
		const dw = await domainWorld();
		const first = await run(dw, { patch: { waitMs: 600_000 } });
		expect(first.outcome.status).toBe('failed');
		dw.ops = 1;
		const second = await run(dw, { script: { onSleep: owner(dw) } });
		expect(second.outcome.status).toBe('succeeded');
		expect(claimOf(dw)).toMatchObject({ epoch: 2, state: 'routed' });
	});

	it('fails the ownership stage when the provider drops the hostname', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			script: {
				onSleep: (count) => {
					if (count === 2) dw.provider.set(HOST, { status: 'blocked' });
				}
			}
		});
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, input)).reason).toBe('ownership_failed');
		expect(claimOf(dw)?.state).toBe('released');
	});

	it('fails the certificate stage with its own reason', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			script: {
				onSleep: (count) => {
					if (count === 1) dw.provider.set(HOST, { status: 'active' });
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

	it('unwinds the route when the final check never passes', async () => {
		const dw = await domainWorld();
		const { outcome, input } = await run(dw, {
			patch: { waitMs: 3_600_000 },
			script: {
				onSleep: (count) => {
					if (count === 1) dw.provider.set(HOST, { status: 'active', ssl: 'active' });
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
		for (let attempt = 0; attempt < 300 && outcome === null; attempt++) {
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
		expect(claimOf(dw)).toMatchObject({ state: 'routed', epoch: 1 });
		expect(routeOf(dw)?.siteId).toBe(dw.world.siteId);
	});

	it('survives losing the answer of the request step after the provider created the hostname', async () => {
		const dw = await domainWorld();
		const input = inputOf(dw);
		await begin(dw, input);
		const memo: Memo = new Map();
		const killed = runnerFor(dw, memo, { killAfter: 3 });
		await expect(runDomainAttach(killed.runner, dw.deps, input)).rejects.toBeInstanceOf(Killed);
		const lost = runnerFor(dw, memo, { killDuring: 1, onSleep: owner(dw) });
		await expect(runDomainAttach(lost.runner, dw.deps, input)).rejects.toBeInstanceOf(Killed);
		const again = runnerFor(dw, memo, { onSleep: owner(dw) });
		expect(await runDomainAttach(again.runner, dw.deps, input)).toEqual({
			status: 'succeeded'
		});
		expect(dw.provider.held.size).toBe(1);
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

	it('refuses plainly when custom domains are off and leaves no claim behind', async () => {
		const dw = await domainWorld();
		dw.provider.turnOff('custom domains have no zone or target configured for this deploy');
		const { outcome, input } = await run(dw);
		expect(outcome.status).toBe('failed');
		const operation = await operationOf(dw, input);
		expect((await stateOf(dw, input)).reason).toBe('custom_domains_off');
		expect(
			failureReason({
				type: 'domain.attach',
				status: 'failed',
				failedStep: 'request',
				failedError: operation.steps.find((step) => step.id === 'request')?.error
			})
		).toMatch(/not turned on/);
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
		const input = inputOf(dw, other);
		const { outcome } = await run(dw, {
			patch: other,
			script: {
				onSleep: (count) => {
					served.push(routeOf(dw)?.siteId ?? null);
					owner(dw)?.(count);
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
			state: 'routed',
			operation_id: input.operationId
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
		const second = await run(dw, { patch: other, script: { onSleep: owner(dw) } });
		expect(second.outcome.status).toBe('succeeded');
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);

		const resumed = runnerFor(dw, memo, {});
		const outcome = await runDomainAttach(resumed.runner, dw.deps, first);
		expect(outcome.status).toBe('failed');
		expect((await stateOf(dw, first)).reason).toBe('hostname_taken');
		expect(routeOf(dw)?.siteId).toBe(dw.siteB);
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, state: 'routed' });
		expect(dw.provider.held.get(HOST)?.id).toBe(claimOf(dw)!.provider_id);
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
		expect(await dw.deps.domains.markRouted(HOST, 1, dw.world.siteId)).toBe(false);
		expect(await dw.deps.domains.release(HOST, 1, dw.world.siteId)).toBe(false);
		expect(claimOf(dw)).toMatchObject({ site_id: dw.siteB, epoch: 2, state: 'claimed' });
		expect(await dw.deps.domains.markRouted(HOST, 2, other.siteId)).toBe(true);
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
					purpose: 'ownership',
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
