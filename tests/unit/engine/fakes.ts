import type { D1Database } from '@cloudflare/workers-types';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
	generateSigningKey,
	sha256Hex,
	toBase64Url,
	type SigningKey
} from '../../../contracts/src/common';
import type { AuthorityState } from '../../../contracts/src/site-auth';
import type { SitePlane } from '../../../contracts/src/sites';
import { applyTo, readAuthority, signApply } from '../../../dispatch/src/authority';
import { releaseIn, reserveIn, type NameRecord } from '../../../dispatch/src/registry';
import { custodyOf } from '../../../engine/src/adapters/custody';
import { assetHashOf, bundleKeys, type BundleManifest } from '../../../engine/src/bundle';
import {
	acquire,
	check,
	EMPTY_LEASE,
	heartbeat,
	release,
	type LeaseState
} from '../../../engine/src/lease';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import { D1OperationStore } from '../../../engine/src/operations/store';
import { D1ResourceLedger } from '../../../engine/src/ownership';
import type {
	AssetSession,
	Authority,
	Cloudflare,
	EngineDeps,
	HostRoute,
	Leases,
	Names,
	RateHeadroom,
	Releases,
	Site
} from '../../../engine/src/ports';
import type { ResourceKind } from '../../../engine/src/provision-plan';
import { PermanentError, StepFailed, type StepRunner } from '../../../engine/src/step';
import { planSiteCreate, type SiteCreateInput } from '../../../engine/src/workflows/site-create';
import { SCHEMA_STATEMENTS, SCHEMA_TRIGGERS } from '../../../src/server/db/schema';
import { shardKey } from '../../../src/shared/names';
import { memoryKv } from '../dispatch/fakes';

// #region d1 over node:sqlite

type Result = { results: unknown[]; success: true; meta: { changes: number } };

class Statement {
	constructor(
		private readonly sqlite: DatabaseSync,
		readonly sql: string,
		private readonly params: SQLInputValue[] = []
	) {}

	bind(...params: unknown[]) {
		return new Statement(this.sqlite, this.sql, params as SQLInputValue[]);
	}

	exec(): Result {
		const prepared = this.sqlite.prepare(this.sql);
		if (/^\s*select/i.test(this.sql) || /\sreturning\s/i.test(this.sql)) {
			return { results: prepared.all(...this.params), success: true, meta: { changes: 0 } };
		}
		const { changes } = prepared.run(...this.params);
		return { results: [], success: true, meta: { changes: Number(changes) } };
	}

	async run() {
		return this.exec();
	}

	async all() {
		return this.exec();
	}

	async first() {
		return (this.exec().results[0] as unknown) ?? null;
	}
}

export function memoryD1(): { db: D1Database; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(':memory:');
	for (const statement of [...SCHEMA_STATEMENTS, ...SCHEMA_TRIGGERS]) sqlite.exec(statement);
	const db = {
		prepare: (sql: string) => new Statement(sqlite, sql),
		async batch(statements: Statement[]) {
			sqlite.exec('BEGIN');
			try {
				const results = statements.map((statement) => statement.exec());
				sqlite.exec('COMMIT');
				return results;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		}
	};
	return { db: db as unknown as D1Database, sqlite };
}

// #endregion

// #region the cloudflare account

export interface AccountSnapshot {
	kv: [string, string][];
	r2: string[];
	d1: [string, string][];
	scripts: string[];
	assets: string[];
	routes: string[];
}

interface FakeScript {
	main: string;
	modules: string[];
	metadata: string;
	tags: string[];
	version: number;
}

const NO_RATE: RateHeadroom = {
	remaining: null,
	resetSeconds: null,
	quota: null,
	windowSeconds: null
};

export function fakeCloudflare() {
	const kv = new Map<string, string>();
	const r2 = new Set<string>();
	const d1 = new Map<string, string>();
	const scripts = new Map<string, FakeScript>();
	const routes = new Map<string, { zoneId: string; pattern: string; script: string | null }>();
	const uploaded = new Map<string, Set<string>>();
	const sessions = new Map<string, { script: string; needed: Set<string> }>();
	const counts = { create: 0, find: 0, delete: 0, putScript: 0, session: 0, bucket: 0 };
	const hooks: { beforeCreate?: (kind: ResourceKind, name: string) => void } = {};
	// each read takes the next queued reading, then falls back to the standing one
	const usage = { rate: { ...NO_RATE }, queue: [] as RateHeadroom[] };
	let sequence = 0;

	const table = (kind: ResourceKind) => (kind === 'kv' ? kv : kind === 'd1' ? d1 : null);

	const cloudflare: Cloudflare = {
		async listResources(kind) {
			if (kind === 'r2') return [...r2].map((name) => ({ id: name, name }));
			return [...table(kind)!].map(([id, name]) => ({ id, name }));
		},
		async getScript(name) {
			const script = scripts.get(name);
			return script === undefined
				? null
				: { tags: [...script.tags], version: String(script.version) };
		},
		async listRoutes(zoneId) {
			return [...routes]
				.filter(([, route]) => route.zoneId === zoneId)
				.map(([id, route]) => ({ id, ...route }));
		},
		async readUsage() {
			return {
				kvNamespaces: kv.size,
				buckets: r2.size,
				rate: { ...(usage.queue.shift() ?? usage.rate) }
			};
		},
		async addRoute(zoneId, pattern, script) {
			const id = `route-${++sequence}`;
			routes.set(id, { zoneId, pattern, script });
			return { providerId: id };
		},
		async removeRoute(_zoneId, routeId) {
			return routes.delete(routeId) ? 'deleted' : 'absent';
		},
		async findResource(kind, name) {
			counts.find++;
			if (kind === 'r2') return r2.has(name) ? { providerId: name } : null;
			for (const [id, title] of table(kind)!) if (title === name) return { providerId: id };
			return null;
		},
		async createResource(kind, name) {
			hooks.beforeCreate?.(kind, name);
			counts.create++;
			if (kind === 'r2') {
				if (r2.has(name)) throw new Error(`bucket ${name} already exists`);
				r2.add(name);
				return { providerId: name };
			}
			const map = table(kind)!;
			if ([...map.values()].includes(name)) throw new Error(`${kind} ${name} already exists`);
			const id = `${kind}-${++sequence}`;
			map.set(id, name);
			return { providerId: id };
		},
		async deleteResource(kind, providerId) {
			counts.delete++;
			if (kind === 'r2') return r2.delete(providerId) ? 'deleted' : 'absent';
			return table(kind)!.delete(providerId) ? 'deleted' : 'absent';
		},
		async putScript(name, upload) {
			counts.putScript++;
			// the completion token has to be in the metadata, which only exists after the assets
			const token = (upload.metadata.assets as { jwt?: string } | undefined)?.jwt;
			if (token === undefined || !token.startsWith('completion:')) {
				throw new PermanentError(
					'assets_not_complete',
					'the script has no completion token'
				);
			}
			scripts.set(name, {
				main: upload.main,
				modules: upload.modules.map(({ module }) => module.name).sort(),
				metadata: JSON.stringify(upload.metadata),
				tags: [...(upload.metadata.tags ?? [])],
				version: (scripts.get(name)?.version ?? 0) + 1
			});
			return { versionId: null };
		},
		async deleteScript(name) {
			counts.delete++;
			uploaded.delete(name);
			return scripts.delete(name) ? 'deleted' : 'absent';
		},
		async startAssetSession(script, manifest): Promise<AssetSession> {
			counts.session++;
			const have = uploaded.get(script) ?? new Set<string>();
			const needed = [...new Set(Object.values(manifest).map((entry) => entry.hash))]
				.filter((hash) => !have.has(hash))
				.sort();
			if (needed.length === 0)
				return { jwt: `completion:${script}`, buckets: [], complete: true };
			const jwt = `session:${script}:${++sequence}`;
			sessions.set(jwt, { script, needed: new Set(needed) });
			const buckets: string[][] = [];
			for (let i = 0; i < needed.length; i += 2) buckets.push(needed.slice(i, i + 2));
			return { jwt, buckets, complete: false };
		},
		async uploadAssetBucket(jwt, files) {
			counts.bucket++;
			const session = sessions.get(jwt);
			if (session === undefined) throw new Error('unknown asset session');
			const have = uploaded.get(session.script) ?? new Set<string>();
			for (const file of files) {
				have.add(file.hash);
				session.needed.delete(file.hash);
			}
			uploaded.set(session.script, have);
			return session.needed.size === 0 ? `completion:${session.script}` : jwt;
		}
	};

	return {
		cloudflare,
		counts,
		hooks,
		usage,
		snapshot(): AccountSnapshot {
			return {
				kv: [...kv].sort(),
				r2: [...r2].sort(),
				d1: [...d1].sort(),
				scripts: [...scripts]
					.map(([name, value]) => `${name}:${value.main}:${value.modules}:${value.tags}`)
					.sort(),
				assets: [...uploaded]
					.flatMap(([script, hashes]) => [...hashes].map((h) => `${script}:${h}`))
					.sort(),
				routes: [...routes]
					.map(([id, r]) => `${id}:${r.zoneId}:${r.pattern}:${r.script}`)
					.sort()
			};
		},
		// everything in the account including versions and metadata, for byte-for-byte checks
		deep() {
			return JSON.stringify({
				kv: [...kv].sort(),
				r2: [...r2].sort(),
				d1: [...d1].sort(),
				scripts: [...scripts].sort(([a], [b]) => a.localeCompare(b)),
				routes: [...routes].sort(([a], [b]) => a.localeCompare(b)),
				uploaded: [...uploaded].map(([s, h]) => [s, [...h].sort()]).sort()
			});
		},
		// someone else's script changes: new tags and a new version
		tamper(name: string, change: { tags?: string[] }) {
			const script = scripts.get(name)!;
			script.version++;
			if (change.tags !== undefined) script.tags = change.tags;
		},
		// the customer's own things, some named exactly like what a site of ours would create
		seedCustomer(
			lookAlikes: { kv?: string[]; r2?: string[]; d1?: string[]; script?: string } = {}
		) {
			for (const title of ['customer-sessions', 'prod-cache', ...(lookAlikes.kv ?? [])]) {
				kv.set(`kv-c${++sequence}`, title);
			}
			for (const name of ['customer-assets', ...(lookAlikes.r2 ?? [])]) r2.add(name);
			for (const name of ['customer-db', ...(lookAlikes.d1 ?? [])]) {
				d1.set(`d1-c${++sequence}`, name);
			}
			const own = (main: string, tags: string[]): FakeScript => ({
				main,
				modules: [main],
				metadata: '{}',
				tags,
				version: 1
			});
			scripts.set('customer-api', own('api.js', ['team:web']));
			scripts.set('legacy-worker', own('legacy.js', []));
			if (lookAlikes.script !== undefined)
				scripts.set(lookAlikes.script, own('theirs.js', []));
			routes.set('route-c1', {
				zoneId: 'zone-1',
				pattern: 'www.customer.com/*',
				script: 'customer-api'
			});
			routes.set('route-c2', {
				zoneId: 'zone-1',
				pattern: '*.shop.customer.com/*',
				script: 'legacy-worker'
			});
			uploaded.set('customer-api', new Set(['asset-a', 'asset-b']));
		},
		scripts
	};
}

// #endregion

// #region authority, names, leases, site, releases

export async function fakeAuthority(now: () => number) {
	const control: SigningKey = await generateSigningKey();
	const kvs = new Map<string, ReturnType<typeof memoryKv>>();
	const hosts = new Map<string, HostRoute>();
	const objectOf = (siteId: string) => {
		let kv = kvs.get(siteId);
		if (kv === undefined) kvs.set(siteId, (kv = memoryKv()));
		return kv;
	};
	const authority: Authority = {
		async read(siteId) {
			return readAuthority(objectOf(siteId)) ?? null;
		},
		async apply(state) {
			const message = await signApply(state, now(), control.privateKey);
			const answer = await applyTo(objectOf(state.siteId), message, {
				controlKey: control.publicKey,
				now: now(),
				expectedSiteId: state.siteId
			});
			if (!answer.ok) throw new PermanentError(`authority_${answer.code}`, answer.code);
			return answer.value;
		},
		async putHost(host, route) {
			hosts.set(host, structuredClone(route));
		},
		async deleteHostIfOwned(host, siteId) {
			const route = hosts.get(host);
			if (route === undefined) return 'absent';
			if (route.siteId !== siteId) return 'foreign';
			hosts.delete(host);
			return 'deleted';
		}
	};
	return {
		authority,
		snapshot: () => ({
			hosts: [...hosts].sort(),
			states: [...kvs].map(([siteId, kv]) => [siteId, readAuthority(kv) ?? null]).sort()
		}),
		stateOf: (siteId: string): AuthorityState | undefined => readAuthority(objectOf(siteId))
	};
}

export function fakeNames(now: () => number) {
	const kv = memoryKv();
	const calls: string[] = [];
	const names: Names = {
		async reserve(name, siteId) {
			calls.push(`reserve:${name}`);
			return reserveIn(kv, name, siteId, now(), shardKey(name));
		},
		async confirm(name, siteId) {
			return reserveIn(kv, name, siteId, now(), shardKey(name)) === 'reserved';
		},
		async release(name, siteId, holdMs) {
			calls.push(`release:${name}`);
			return releaseIn(kv, name, siteId, now(), holdMs);
		}
	};
	return {
		names,
		calls,
		recordOf: (name: string) => kv.get<NameRecord>(`name:${name}`) ?? null,
		// free for any site to claim right now
		isFree(name: string) {
			const record = kv.get<NameRecord>(`name:${name}`);
			return record === undefined || (record.state === 'held' && now() >= record.until);
		}
	};
}

export function fakeLeases(now: () => number) {
	const states = new Map<string, LeaseState>();
	const read = (siteId: string) => states.get(siteId) ?? EMPTY_LEASE;
	const leases: Leases = {
		async acquire(siteId, request) {
			const { state, result } = acquire(read(siteId), { ...request, now: now() });
			states.set(siteId, state);
			return result;
		},
		async heartbeat(siteId, request) {
			const { state, result } = heartbeat(read(siteId), { ...request, now: now() });
			states.set(siteId, state);
			return result;
		},
		async release(siteId, request) {
			const { state, result } = release(read(siteId), { ...request, now: now() });
			states.set(siteId, state);
			return result;
		},
		async check(siteId, request) {
			return check(read(siteId), { ...request, now: now() });
		}
	};
	return { leases, stateOf: read };
}

// recognisable values the scan specs search for; none of them may reach a stored artefact
export const FAKE_OWNER_TOKEN = 'otk-Zq8mR4vN2xLw9HcT7pYs3KdA6eJb5UfG';
export const FAKE_ADMIN_PASSWORD = 'pw-Xv7Lq2Rn8Tz4Wm9Hd3Ks6Bc5Yj1Pf';

export function fakeSite() {
	const calls = { probe: 0, firstRun: 0 };
	const answers = { probe: 200, firstRun: 200 };
	// what the site was handed on each probe, kept here and nowhere a workflow can store it
	const bearers: (string | null)[] = [];
	let claimed = false;
	const site: Site = {
		async probe(_hostname, _path, _expectStatus, auth) {
			calls.probe++;
			bearers.push(auth?.bearer ?? null);
			return { status: answers.probe };
		},
		// the worker mints a token and a password on the first claim and refuses a second
		async firstRun(_hostname, call) {
			calls.firstRun++;
			const { reads } = call;
			if (reads === undefined) return { status: answers.firstRun };
			if (answers.firstRun < 200 || answers.firstRun >= 300) {
				return { status: answers.firstRun };
			}
			if (claimed) return { status: 409 };
			claimed = true;
			return {
				status: answers.firstRun,
				secrets: {
					ownerToken: reads.ownerToken === undefined ? null : FAKE_OWNER_TOKEN,
					adminPassword: reads.adminPassword === undefined ? null : FAKE_ADMIN_PASSWORD
				}
			};
		}
	};
	return { site, calls, answers, bearers };
}

export interface FakeBundle {
	manifest: BundleManifest;
	parts: Map<string, Uint8Array>;
}

const text = (value: string) => new TextEncoder().encode(value);

export async function makeBundle(
	releaseId = 'v1.0.4',
	assetCount = 5,
	assetBytes = 40
): Promise<FakeBundle> {
	const parts = new Map<string, Uint8Array>();
	const moduleSources: [string, string, string][] = [
		[
			'index.js',
			'application/javascript+module',
			'export default { fetch() { return new Response("ok"); } };'
		],
		['php.wasm', 'application/wasm', 'wasm-bytes']
	];
	const modules = [];
	for (const [name, contentType, source] of moduleSources) {
		const bytes = text(source);
		parts.set(bundleKeys.module(releaseId, name), bytes);
		modules.push({ name, contentType, sha256: await sha256Hex(bytes), size: bytes.byteLength });
	}
	const metadataBytes = text('{"compatibility_date":"2026-08-01"}');
	parts.set(bundleKeys.metadata(releaseId), metadataBytes);
	const assets = [];
	for (let i = 0; i < assetCount; i++) {
		const bytes = text(`asset ${i} `.padEnd(assetBytes, 'x'));
		const hash = await assetHashOf(bytes);
		parts.set(bundleKeys.asset(releaseId, hash), bytes);
		assets.push({ path: `/files/${i}.txt`, hash, size: bytes.byteLength });
	}
	const manifest = {
		v: 1,
		releaseId,
		workerCommit: 'a'.repeat(40),
		mainModule: 'index.js',
		modules,
		metadata: { sha256: await sha256Hex(metadataBytes), size: metadataBytes.byteLength },
		assets,
		counts: { modules: modules.length, assets: assets.length }
	} as BundleManifest;
	return { manifest, parts };
}

export function releasesOf(bundle: FakeBundle): Releases {
	return {
		async manifest(releaseId) {
			if (releaseId !== bundle.manifest.releaseId)
				throw new PermanentError('release_not_found', releaseId);
			return structuredClone(bundle.manifest);
		},
		async part(key) {
			const bytes = bundle.parts.get(key);
			if (bytes === undefined) throw new PermanentError('release_part_missing', key);
			return bytes;
		}
	};
}

// #endregion

// #region step runner that can be killed and resumed

export class Killed extends Error {
	constructor(readonly at: number) {
		super(`killed at step execution ${at}`);
		this.name = 'Killed';
	}
}

export type Memo = Map<string, { ok: true; value: unknown } | { ok: false; reason: unknown }>;

export interface RunnerScript {
	// stop before the next step runs, once this many have run in this attempt
	killAfter?: number;
	// run this step's effect (1-based) and die before its result is saved
	killDuring?: number;
	// a step that ran out of retries: before or after its effect
	failAt?: { step: string; when: 'before' | 'after' };
	// how many times a step is retried after a retryable error
	retries?: number;
}

export function makeRunner(memo: Memo, script: RunnerScript = {}) {
	const executed: string[] = [];
	const runner: StepRunner = {
		async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
			const saved = memo.get(name);
			if (saved !== undefined) {
				if (saved.ok) return structuredClone(saved.value) as T;
				throw new StepFailed(name, saved.reason);
			}
			if (script.killAfter !== undefined && executed.length >= script.killAfter) {
				throw new Killed(executed.length);
			}
			executed.push(name);
			if (script.failAt?.step === name && script.failAt.when === 'before') {
				const reason = new Error(`injected before ${name}`);
				memo.set(name, { ok: false, reason });
				throw new StepFailed(name, reason);
			}
			let value: T;
			// a workflow retries anything that is not a permanent refusal before it gives up
			for (let tries = 0; ; tries++) {
				try {
					value = await fn();
					break;
				} catch (error) {
					if (error instanceof Killed) throw error;
					if (!(error instanceof PermanentError) && tries < (script.retries ?? 0))
						continue;
					memo.set(name, { ok: false, reason: error });
					throw new StepFailed(name, error);
				}
			}
			if (script.killDuring === executed.length) throw new Killed(executed.length);
			if (script.failAt?.step === name && script.failAt.when === 'after') {
				const reason = new Error(`injected after ${name}`);
				memo.set(name, { ok: false, reason });
				throw new StepFailed(name, reason);
			}
			memo.set(name, { ok: true, value: structuredClone(value) });
			return value;
		}
	};
	return { runner, executed };
}

// #endregion

// #region the world a workflow runs in

export const PENDING_TTL_MS = 600_000;

export const LIMITS = {
	maxModuleBytes: 1_000_000,
	maxTotalBytes: 10_000_000,
	maxAssetBytes: 100_000,
	maxAssets: 1_000
};

export async function makeWorld(
	options: {
		config?: 'managed' | 'canonical';
		assetCount?: number;
		database?: boolean;
		plane?: SitePlane;
		zoneId?: string;
	} = {}
) {
	const start = 1_790_000_000_000;
	let current = start;
	const clock = {
		now: () => current,
		advance: (ms: number) => void (current += ms),
		set: (value: number) => void (current = value)
	};
	const { db, sqlite } = memoryD1();
	const store = new D1OperationStore(db);
	const ledger = new D1ResourceLedger(db);
	const cf = fakeCloudflare();
	const authority = await fakeAuthority(clock.now);
	const names = fakeNames(clock.now);
	const leases = fakeLeases(clock.now);
	const site = fakeSite();
	const bundle = await makeBundle('v1.0.4', options.assetCount ?? 5);
	const deps: EngineDeps = {
		store,
		ledger,
		cloudflare: cf.cloudflare,
		authority: authority.authority,
		names: names.names,
		site: site.site,
		custody: custodyOf({
			db,
			secrets: { KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) },
			pendingTtlMs: PENDING_TTL_MS,
			now: clock.now
		}),
		releases: releasesOf(bundle),
		leases: leases.leases,
		now: clock.now,
		config: {
			leaseTtlMs: 120_000,
			chunkBytes: 1_000,
			assetSessionMs: 3_300_000,
			limits: { ...LIMITS }
		}
	};
	// fixed ids, so two runs of the same scenario can be compared field for field
	const siteId = `site_${'s'.repeat(26)}`;
	const orgId = `org_${'o'.repeat(26)}`;
	const operationId = `op_${'p'.repeat(26)}`;
	const accountId = 'a'.repeat(32);
	const input: SiteCreateInput = {
		operationId,
		site: {
			id: siteId,
			orgId,
			name: 'Quiet Otter',
			kind: 'drupal',
			category: 'cms',
			plane: options.plane ?? 'managed',
			config: options.config ?? 'managed',
			ring: 'R1',
			plan: 'free',
			accountId
		},
		subdomain: 'quiet-otter',
		hostname: 'quiet-otter.drupflare.app',
		zoneId: options.zoneId,
		releaseId: 'v1.0.4',
		database: options.database,
		authority: {
			risk: 'new-free',
			limits: { cpuMs: 50, subRequests: 20 },
			accessRuleHash: `sha256:${'0'.repeat(64)}`
		},
		firstRun: {
			method: 'POST',
			path: '/first-run',
			reads: { ownerToken: 'ownerToken', adminPassword: 'adminPass' }
		},
		probe: { path: '/health', expectStatus: 200, auth: 'owner-token' }
	};
	return {
		deps,
		store,
		ledger,
		sqlite,
		cf,
		authority,
		names,
		leases,
		site,
		bundle,
		clock,
		input,
		siteId,
		orgId,
		operationId,
		accountId
	};
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

export async function beginCreate(world: World, key = 'create-1') {
	const frozen = await freezePlan(planSiteCreate(world.input));
	const operation = newOperation({
		id: world.operationId,
		orgId: world.orgId,
		idempotencyKey: key,
		frozen,
		now: world.clock.now()
	});
	return world.store.begin({
		operation,
		accountId: world.accountId,
		siteId: world.siteId
	});
}

// which secrets are sealed, by id only: the ciphertext differs on every seal
export function custodyRows(world: World) {
	const owners = world.sqlite.prepare('SELECT site_id FROM owner_tokens').all();
	const pending = world.sqlite.prepare('SELECT site_id, kind FROM pending_secrets').all();
	return {
		ownerToken: owners.length > 0,
		pending: pending.map((row) => `${row.site_id}:${row.kind}`).sort()
	};
}

// everything a run leaves behind, without the fields that legitimately differ after a retry
async function operationView(world: World, id: string) {
	const operation = await world.store.get(id);
	return (
		operation && {
			status: operation.status,
			verification: operation.verification,
			fencingEpoch: operation.fencingEpoch,
			cursor: operation.cursor,
			steps: operation.steps.map((step) => [step.id, step.state]),
			observation: operation.finalObservation?.summary ?? null
		}
	);
}

export async function snapshotWorld(world: World, others: string[] = []) {
	return {
		operation: await operationView(world, world.operationId),
		others: await Promise.all(others.map((id) => operationView(world, id))),
		resources: (await world.ledger.all(world.siteId)).map((row) => [
			row.kind,
			row.binding,
			row.name,
			row.providerId,
			row.createdByOperation,
			row.deletedAt !== null
		]),
		siteState: await world.store.siteState(world.siteId),
		custody: custodyRows(world),
		account: world.cf.snapshot(),
		authority: world.authority.snapshot(),
		lease: world.leases.stateOf(world.siteId),
		name: world.names.recordOf(world.input.subdomain)
	};
}

// #endregion
