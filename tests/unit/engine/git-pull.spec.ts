import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import {
	D1RemoteLedger,
	gitWorkerOf,
	unavailableTokenPull
} from '../../../engine/src/adapters/git';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import {
	boundedText,
	GIT_ERROR_CODES,
	GitError,
	matchRemote,
	parsePull,
	parseRemoteList,
	refusalOf,
	siteProviderOf,
	type GitPullResult,
	type GitRemoteSpec,
	type GitSiteRemote
} from '../../../engine/src/git-parts';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { GitDeps, GitTokenPull } from '../../../engine/src/ports';
import { planGitPull, runGitPull, type GitPullInput } from '../../../engine/src/workflows/git-pull';
import { failureReason } from '../../../src/shared/operation-copy';
import { fakeBlobs } from './backup-fakes';
import {
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	type Memo,
	type RunnerScript
} from './fakes';

const OP = `op_${'g'.repeat(26)}`;
const SITE_HOST = 'git.drupflare.app';
const CONNECTION = 'conn_1';
const REMOTE = 'rem_1';
const REPO = 'ops/site';
const MOUNT = 'modules/custom/site';
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const PROVIDER_TOKEN = 'ghs_InstallationTokenForOneCallOnly';

type Behavior =
	| 'ok'
	| 'rolled-back'
	| 'no-module'
	| 'conflict'
	| 'missing-branch'
	| 'nothing'
	| 'unreadable'
	| 'unauthorized'
	| 'down'
	| 'blip';

// the released site's /git owner routes over fetch: a list and a pull by the site's own remote id
function fakeGitSite() {
	const calls: { url: string; authorization: string | null }[] = [];
	const state = {
		remotes: [
			{ id: `github:${REPO}@main`, provider: 'github', repo: REPO, branch: 'main' }
		] as (GitSiteRemote & { mount?: string })[],
		behavior: 'ok' as Behavior,
		blips: 1,
		pulls: 0
	};
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const authorization = new Headers(init?.headers).get('authorization');
		calls.push({ url: `${url.pathname}${url.search}`, authorization });
		if (url.host !== SITE_HOST) return new Response('no such site', { status: 404 });
		if (url.pathname !== '/git') return new Response('unknown', { status: 404 });
		if (state.behavior === 'unauthorized') return new Response('no', { status: 401 });
		if (state.behavior === 'down') throw new Error('connection refused');
		const action = url.searchParams.get('action');
		if (action === 'list') return Response.json({ ok: true, remotes: state.remotes });
		if (action !== 'pull')
			return Response.json({ ok: false, error: 'unknown action' }, { status: 404 });
		state.pulls++;
		if (state.behavior === 'blip' && state.blips-- > 0) {
			return new Response('busy', { status: 503 });
		}
		switch (state.behavior) {
			case 'rolled-back':
				return Response.json({
					ok: false,
					applied: false,
					rolledBack: true,
					error: 'rolled back: Fatal error at /var/www/secret/module.php'
				});
			case 'no-module':
				return Response.json({
					ok: false,
					error: 'that commit carries no mountable module'
				});
			case 'conflict':
				return Response.json({
					ok: false,
					applied: false,
					error: '2 path(s) belong to another remote'
				});
			case 'nothing':
				return Response.json({ ok: false, error: 'nothing to pull' }, { status: 400 });
			case 'missing-branch':
				return Response.json(
					{ ok: false, error: 'the remote has no branch main' },
					{ status: 400 }
				);
			case 'unreadable':
				return new Response('not json', { status: 200 });
			default:
				return Response.json({
					ok: true,
					sha: SHA,
					applied: true,
					rolledBack: false,
					counts: { added: 2, modified: 1, removed: 0, unchanged: 4 }
				});
		}
	}) as typeof fetch;
	return { fetcher, calls, state };
}

// stands in for the call the released site cannot take: the token is minted here for one call and
// sent in a header, never in a URL
function fakeTokenPull(site: ReturnType<typeof fakeGitSite>) {
	const minted: string[] = [];
	const sent: { remote: GitRemoteSpec; header: string }[] = [];
	const tokenPull: GitTokenPull = {
		async pull(target, remote, auth): Promise<GitPullResult> {
			const token = `${PROVIDER_TOKEN}-${minted.length + 1}`;
			minted.push(token);
			sent.push({ remote, header: `Bearer ${auth.bearer} ${token}` });
			site.state.pulls++;
			return { sha: SHA, changed: 3 };
		}
	};
	return { tokenPull, minted, sent };
}

interface WorldOptions {
	remoteOnSite?: boolean;
	mount?: string;
	state?: string;
	sealToken?: boolean;
	remoteRow?: boolean;
	provider?: string;
	real?: boolean;
}

async function gitWorld(options: WorldOptions = {}) {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const site = fakeGitSite();
	const token = fakeTokenPull(site);
	const siteId = world.siteId;
	const now = world.clock.now();
	await world.store.activateSite(
		{
			id: siteId,
			organizationId: world.orgId,
			name: siteId,
			plane: 'managed',
			accountId: world.accountId,
			category: 'cms',
			config: 'managed'
		},
		now
	);
	world.sqlite
		.prepare('UPDATE sites SET primary_hostname = ?, state = ? WHERE id = ?')
		.run(SITE_HOST, options.state ?? 'active', siteId);
	if (options.sealToken !== false)
		await world.deps.custody.sealOwnerToken(siteId, FAKE_OWNER_TOKEN);
	const provider = options.provider ?? 'github';
	world.sqlite
		.prepare(
			`INSERT INTO repo_connections (id, organization_id, provider, external_id, display_name,
			credential_envelope, scopes, state, created_at, revoked_at)
			VALUES (?, ?, ?, '42', 'GitHub installation 42', NULL, '[]', 'active', ?, NULL)`
		)
		.run(CONNECTION, world.orgId, provider, now);
	if (options.remoteRow !== false) {
		world.sqlite
			.prepare(
				`INSERT INTO site_remotes (id, site_id, organization_id, connection_id, repo_full_name,
				branch, mount_path, interval_minutes, last_pull_status, last_pull_at, created_at)
				VALUES (?, ?, ?, ?, ?, 'main', ?, 60, NULL, NULL, ?)`
			)
			.run(REMOTE, siteId, world.orgId, CONNECTION, REPO, MOUNT, now);
	}
	if (options.remoteOnSite === false) site.state.remotes = [];
	if (options.mount !== undefined) site.state.remotes[0]!.mount = options.mount;
	if (provider === 'forgejo') site.state.remotes[0]!.provider = 'gitea';
	const deps: GitDeps = {
		...world.deps,
		worker: backupWorkerOf(site.fetcher, 1_000),
		blobs: fakeBlobs().blobs,
		backups: new D1BackupLedger(db),
		sleep: async () => {},
		git: gitWorkerOf(site.fetcher, 1_000),
		tokenPull: options.real === true ? unavailableTokenPull : token.tokenPull,
		remotes: new D1RemoteLedger(db)
	};
	const rows = () =>
		world.sqlite
			.prepare(
				`SELECT last_pull_status AS status, last_pull_at AS at, last_pull_reason AS reason
				FROM site_remotes WHERE id = ?`
			)
			.get(REMOTE) as
			{ status: string | null; at: number | null; reason: string | null } | undefined;
	return { world, deps, site, token, rows, siteId, db };
}

type Gw = Awaited<ReturnType<typeof gitWorld>>;

const inputOf = (gw: Gw, patch: Partial<GitPullInput> = {}): GitPullInput => ({
	operationId: OP,
	orgId: gw.world.orgId,
	siteId: gw.siteId,
	accountId: gw.world.accountId,
	remoteId: REMOTE,
	...patch
});

async function begin(gw: Gw, input: GitPullInput) {
	const frozen = await freezePlan(planGitPull(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: gw.world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		now: gw.world.clock.now()
	});
	await gw.world.store.begin({ operation, accountId: gw.world.accountId, siteId: input.siteId });
}

async function run(
	gw: Gw,
	options: {
		memo?: Memo;
		script?: RunnerScript;
		patch?: Partial<GitPullInput>;
		fresh?: boolean;
	} = {}
) {
	const input = inputOf(gw, options.patch);
	if (options.fresh !== false) await begin(gw, input);
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	return { outcome: await runGitPull(runner, gw.deps, input), executed };
}

const operationOf = async (gw: Gw) => (await gw.world.store.get(OP))!;

describe('the pure parts', () => {
	it('plans one site and four steps, and names no remote as a site', () => {
		const plan = planGitPull({ siteId: 'site_a' });
		expect(plan.type).toBe('git.pull');
		expect(plan.targetIds).toEqual(['site_a']);
		expect(plan.blastRadius).toEqual({ sites: 1, destructiveSites: 0, productionDeploys: 0 });
		expect(plan.steps.map((step) => step.id)).toEqual(['lease', 'find', 'pull', 'record']);
	});

	it('matches a repository by provider, branch and name without case, and maps Forgejo to Gitea', () => {
		const remotes: GitSiteRemote[] = [
			{ id: 'a', provider: 'github', repo: 'Ops/Site', branch: 'main', mount: null },
			{ id: 'b', provider: 'gitea', repo: 'ops/site', branch: 'dev', mount: null }
		];
		const spec = (patch: Partial<GitRemoteSpec>): GitRemoteSpec => ({
			provider: 'github',
			repo: 'ops/site',
			branch: 'main',
			mountPath: MOUNT,
			...patch
		});
		expect(matchRemote(remotes, spec({}))?.id).toBe('a');
		expect(matchRemote(remotes, spec({ provider: 'forgejo', branch: 'dev' }))?.id).toBe('b');
		expect(matchRemote(remotes, spec({ branch: 'Main' }))).toBeNull();
		expect(matchRemote(remotes, spec({ provider: 'gitlab' }))).toBeNull();
		expect(siteProviderOf('forgejo')).toBe('gitea');
		expect(siteProviderOf('github')).toBe('github');
	});

	it('reads a remote list and refuses one that is not a list', () => {
		const text = JSON.stringify({
			ok: true,
			remotes: [{ id: 'x', provider: 'github', repo: 'a/b', branch: 'main', extra: 1 }]
		});
		expect(parseRemoteList(text)).toEqual([
			{ id: 'x', provider: 'github', repo: 'a/b', branch: 'main', mount: null }
		]);
		for (const bad of ['nope', '{"remotes":[{"id":""}]}', '[]', null]) {
			expect(() => parseRemoteList(bad)).toThrow(GitError);
		}
	});

	it('reads an applied pull and turns every other answer into a refusal', () => {
		const ok = JSON.stringify({
			ok: true,
			applied: true,
			rolledBack: false,
			sha: SHA,
			counts: { added: 1, modified: 2, removed: 3 }
		});
		expect(parsePull(ok)).toEqual({ sha: SHA, changed: 6 });
		expect(parsePull('{"ok":true,"applied":true}')).toEqual({ sha: null, changed: 0 });
		const cases: [string, string][] = [
			['{"ok":true,"applied":false,"rolledBack":true,"error":"x"}', 'rolled_back'],
			['{"ok":false,"error":"that commit carries no mountable module"}', 'no_module'],
			['{"ok":false,"error":"1 path(s) belong to another remote"}', 'path_conflict'],
			['{"ok":false,"error":"the remote has no branch dev"}', 'no_branch'],
			['{"ok":false,"error":"unknown remote"}', 'remote_gone'],
			['{"ok":false,"error":"the provider answered 403"}', 'pull_refused'],
			['{"ok":true,"applied":false}', 'pull_refused'],
			['not json', 'answer_unreadable'],
			['{"ok":"yes"}', 'answer_unreadable']
		];
		for (const [text, code] of cases) {
			expect(() => parsePull(text)).toThrow(expect.objectContaining({ code }));
		}
		expect(refusalOf({ error: null }).code).toBe('pull_refused');
	});

	it('bounds the site text and drops control characters', () => {
		expect(boundedText('a\u0000b\nc')).toBe('a b c');
		expect(boundedText('x'.repeat(500))).toHaveLength(300);
		expect(boundedText(null)).toBe('');
	});

	it('has plain copy for every code a pull can fail with', () => {
		for (const code of [
			...GIT_ERROR_CODES,
			'site_not_ready',
			'no_owner_token',
			'site_unreachable'
		]) {
			const reason = failureReason({
				type: 'git.pull',
				status: 'failed',
				failedStep: 'pull',
				failedError: `${code}: text`
			});
			expect(reason, code).not.toBe('Stopped while installing the latest commit.');
			expect(reason).not.toMatch(/worker|workflow|durable|container|request \d/i);
		}
	});
});

describe('git.pull', () => {
	it('installs the commit through the site route and writes installed on the remote', async () => {
		const gw = await gitWorld();
		const { outcome } = await run(gw);
		expect(outcome).toEqual({ status: 'succeeded' });
		const operation = await operationOf(gw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.map((step) => step.state)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded'
		]);
		expect(operation.finalObservation?.summary).toContain(SHA.slice(0, 12));
		expect(gw.rows()).toEqual({
			status: 'installed',
			at: gw.world.clock.now(),
			reason: null
		});
		expect(gw.site.calls.map((call) => call.url)).toEqual([
			'/git?action=list',
			`/git?action=pull&id=${encodeURIComponent(`github:${REPO}@main`)}`
		]);
		expect(
			gw.site.calls.every((call) => call.authorization === `Bearer ${FAKE_OWNER_TOKEN}`)
		).toBe(true);
		expect(gw.site.calls.some((call) => call.url.includes(FAKE_OWNER_TOKEN))).toBe(false);
		expect(gw.token.minted).toEqual([]);
	});

	it('lets the next operation take the site once it ends', async () => {
		const gw = await gitWorld();
		await run(gw);
		const granted = await gw.deps.leases.acquire(gw.siteId, {
			holder: 'op_next',
			purpose: 'x',
			ttlMs: 1_000
		});
		expect(granted.ok).toBe(true);
	});

	it('matches a Forgejo connection to the site provider Gitea', async () => {
		const gw = await gitWorld({ provider: 'forgejo' });
		expect((await run(gw)).outcome).toEqual({ status: 'succeeded' });
		expect(gw.site.state.pulls).toBe(1);
	});

	it('mints a provider token per call for a repository the site does not follow yet, and stores none', async () => {
		const gw = await gitWorld({ remoteOnSite: false });
		expect((await run(gw)).outcome).toEqual({ status: 'succeeded' });
		expect(gw.token.minted).toHaveLength(1);
		expect(gw.token.sent[0]!.remote).toEqual({
			provider: 'github',
			repo: REPO,
			branch: 'main',
			mountPath: MOUNT
		});
		const dump = JSON.stringify([
			gw.world.sqlite.prepare('SELECT * FROM operations').all(),
			gw.world.sqlite.prepare('SELECT * FROM operation_steps').all(),
			gw.world.sqlite.prepare('SELECT * FROM site_remotes').all(),
			gw.site.calls.map((call) => call.url)
		]);
		expect(dump).not.toContain(PROVIDER_TOKEN);
		expect(dump).not.toContain(FAKE_OWNER_TOKEN);
		expect(gw.rows()?.status).toBe('installed');
	});

	it('mints a new token for every pull', async () => {
		const gw = await gitWorld({ remoteOnSite: false });
		await run(gw);
		await begin(gw, inputOf(gw, { operationId: `op_${'h'.repeat(26)}` }));
		const { runner } = makeRunner(new Map());
		await runGitPull(runner, gw.deps, inputOf(gw, { operationId: `op_${'h'.repeat(26)}` }));
		expect(gw.token.minted).toHaveLength(2);
		expect(new Set(gw.token.minted).size).toBe(2);
	});

	it('refuses a repository the site does not follow while the site cannot take a token for one call', async () => {
		const gw = await gitWorld({ remoteOnSite: false, real: true });
		const { outcome } = await run(gw);
		expect(outcome.status).toBe('failed');
		expect(outcome.status === 'failed' && outcome.reason).toContain('remote_not_on_site');
		expect((await operationOf(gw)).status).toBe('failed');
		expect(gw.rows()).toMatchObject({
			status: 'failed',
			reason: "This site does not follow the repository yet, and Drupflare cannot add it for you yet. Add the repository on the site's own Git page, then pull again."
		});
		expect(gw.site.calls.map((call) => call.url)).toEqual(['/git?action=list']);
		expect(gw.token.minted).toEqual([]);
	});

	it('refuses a site that follows the repository at another folder', async () => {
		const gw = await gitWorld({ mount: 'modules/other' });
		const { outcome } = await run(gw);
		expect(outcome.status).toBe('failed');
		expect(gw.rows()?.reason).toContain('different folder');
		expect(gw.site.state.pulls).toBe(0);
	});

	it('accepts a site that follows it at the same folder', async () => {
		const gw = await gitWorld({ mount: MOUNT });
		expect((await run(gw)).outcome).toEqual({ status: 'succeeded' });
	});

	const refusals: [string, Behavior | null, WorldOptions, string, string][] = [
		['a rolled back commit', 'rolled-back', {}, 'rolled_back', 'went back to the code it had'],
		['a commit with no module', 'no-module', {}, 'no_module', 'no Drupal module'],
		[
			'a path another repository owns',
			'conflict',
			{},
			'path_conflict',
			'belong to another repository'
		],
		['a branch that is gone', 'missing-branch', {}, 'no_branch', 'no branch with that name'],
		['an unclassified refusal', 'nothing', {}, 'pull_refused', 'could not fetch that commit'],
		[
			'an answer that is not readable',
			'unreadable',
			{},
			'answer_unreadable',
			'result is unknown'
		],
		[
			'a refused owner token',
			'unauthorized',
			{},
			'owner_token_rejected',
			'did not accept the access'
		],
		['a site that is not live', null, { state: 'deleted' }, 'site_not_ready', 'not live'],
		[
			'a site with no owner token',
			null,
			{ sealToken: false },
			'no_owner_token',
			'no owner access'
		],
		[
			'a repository detached meanwhile',
			null,
			{ remoteRow: false },
			'remote_gone',
			'no longer follows'
		]
	];

	for (const [name, behavior, options, code, words] of refusals) {
		it(`closes the operation and writes a plain reason for ${name}`, async () => {
			const gw = await gitWorld(options);
			if (behavior !== null) gw.site.state.behavior = behavior;
			const { outcome } = await run(gw);
			expect(outcome.status).toBe('failed');
			expect(outcome.status === 'failed' && outcome.reason).toContain(code);
			const operation = await operationOf(gw);
			expect(operation.status).toBe('failed');
			expect(operation.finalObservation?.summary).toContain(code);
			expect(operation.steps.some((step) => step.state === 'failed')).toBe(true);
			expect(operation.steps.some((step) => step.state === 'pending')).toBe(false);
			const row = gw.rows();
			if (code !== 'remote_gone') {
				expect(row?.status).toBe('failed');
				expect(row?.reason).toContain(words);
				expect(row?.reason).not.toMatch(/worker|workflow|durable|\/var\/www|Fatal/i);
			} else {
				expect(row).toBeUndefined();
			}
			const lease = await gw.deps.leases.acquire(gw.siteId, {
				holder: 'op_next',
				purpose: 'x',
				ttlMs: 1_000
			});
			expect(lease.ok).toBe(true);
		});
	}

	it('stops with the busy copy when another operation holds the site', async () => {
		const gw = await gitWorld();
		await gw.deps.leases.acquire(gw.siteId, {
			holder: 'op_other',
			purpose: 'upgrade',
			ttlMs: 60_000
		});
		const { outcome } = await run(gw);
		expect(outcome.status).toBe('failed');
		expect(gw.rows()?.reason).toContain('Another change to this site was running');
		expect(gw.site.calls).toEqual([]);
		expect((await operationOf(gw)).status).toBe('failed');
	});

	it('reads a site that never answers as unreachable after the retries', async () => {
		const gw = await gitWorld();
		gw.site.state.behavior = 'down';
		const { outcome } = await run(gw, { script: { retries: 2 } });
		expect(outcome.status).toBe('failed');
		expect(gw.rows()?.reason).toBe(
			'The site did not answer. Check that it is online, then pull again.'
		);
		expect((await operationOf(gw)).status).toBe('failed');
	});

	it('retries a brief outage and pulls the same head again', async () => {
		const gw = await gitWorld();
		gw.site.state.behavior = 'blip';
		const { outcome } = await run(gw, { script: { retries: 2 } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(gw.site.state.pulls).toBe(2);
		expect(gw.rows()?.status).toBe('installed');
	});

	it('finishes after the instance dies between steps, without repeating a recorded step', async () => {
		const gw = await gitWorld();
		const memo: Memo = new Map();
		await expect(run(gw, { memo, script: { killAfter: 4 } })).rejects.toBeInstanceOf(Killed);
		expect(gw.rows()?.status).toBeNull();
		const { outcome, executed } = await run(gw, { memo, fresh: false });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed).not.toContain('find');
		expect(gw.site.state.pulls).toBe(1);
		expect((await operationOf(gw)).status).toBe('succeeded');
		expect(gw.rows()?.status).toBe('installed');
	});

	it('pulls again when the instance dies before the pull result was saved, and still ends installed', async () => {
		const gw = await gitWorld();
		const memo: Memo = new Map();
		await expect(run(gw, { memo, script: { killDuring: 4 } })).rejects.toBeInstanceOf(Killed);
		const { outcome } = await run(gw, { memo, fresh: false });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(gw.site.state.pulls).toBe(2);
		const operation = await operationOf(gw);
		expect(operation.status).toBe('succeeded');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(gw.rows()?.status).toBe('installed');
	});

	it('rethrows an interruption that is not a step failure', async () => {
		const gw = await gitWorld();
		await expect(run(gw, { script: { killAfter: 1 } })).rejects.toBeInstanceOf(Killed);
		expect((await operationOf(gw)).status).toBe('running');
	});
});

describe('the adapters', () => {
	it('reads and writes the remote row through the ledger', async () => {
		const gw = await gitWorld();
		const record = await gw.deps.remotes.get(gw.world.orgId, gw.siteId, REMOTE);
		expect(record).toEqual({
			id: REMOTE,
			organizationId: gw.world.orgId,
			siteId: gw.siteId,
			provider: 'github',
			repo: REPO,
			branch: 'main',
			mountPath: MOUNT
		});
		expect(await gw.deps.remotes.get('org_other', gw.siteId, REMOTE)).toBeNull();
		expect(await gw.deps.remotes.get(gw.world.orgId, 'site_other', REMOTE)).toBeNull();
		await gw.deps.remotes.record('rem_missing', { status: 'failed', at: 1, reason: 'x' });
		expect(gw.rows()?.status).toBeNull();
		await gw.deps.remotes.record(REMOTE, { status: 'failed', at: 5, reason: 'why' });
		expect(gw.rows()).toEqual({ status: 'failed', at: 5, reason: 'why' });
		await gw.deps.remotes.record(REMOTE, { status: 'installed', at: 6, reason: null });
		expect(gw.rows()).toEqual({ status: 'installed', at: 6, reason: null });
	});

	it('answers a 5xx and a 429 as retryable and a 404 as a refusal', async () => {
		for (const status of [500, 429]) {
			const worker = gitWorldFetch(status);
			await expect(worker.pull(SITE_HOST, 'a', { bearer: 'b' })).rejects.not.toBeInstanceOf(
				GitError
			);
		}
		const gone = gitWorldFetch(404, { ok: false, error: 'unknown remote' });
		await expect(gone.pull(SITE_HOST, 'a', { bearer: 'b' })).rejects.toMatchObject({
			code: 'remote_gone'
		});
		const unreadable = gitWorldFetch(400, null);
		await expect(unreadable.pull(SITE_HOST, 'a', { bearer: 'b' })).rejects.toMatchObject({
			code: 'pull_refused'
		});
		const listDown = gitWorldFetch(503);
		await expect(listDown.remotes(SITE_HOST, { bearer: 'b' })).rejects.not.toBeInstanceOf(
			GitError
		);
		const listDenied = gitWorldFetch(403);
		await expect(listDenied.remotes(SITE_HOST, { bearer: 'b' })).rejects.toMatchObject({
			code: 'owner_token_rejected'
		});
	});

	it('refuses the token pull without a network call', async () => {
		await expect(
			unavailableTokenPull.pull(
				{ hostname: SITE_HOST, siteId: 's' },
				{ provider: 'github', repo: REPO, branch: 'main', mountPath: MOUNT },
				{ bearer: 'b' }
			)
		).rejects.toMatchObject({ code: 'remote_not_on_site' });
	});
});

function gitWorldFetch(status: number, body: unknown = 'nope') {
	const fetcher = (async () =>
		new Response(typeof body === 'string' ? body : body === null ? 'x' : JSON.stringify(body), {
			status
		})) as unknown as typeof fetch;
	return gitWorkerOf(fetcher, 1_000);
}
