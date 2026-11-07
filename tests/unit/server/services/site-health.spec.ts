import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../../../src/server/domain/authorize';
import {
	HEALTH_CACHE_MS,
	readSiteHealth,
	resetSiteHealthCache,
	resetSiteHealthServices,
	siteHealthServices
} from '../../../../src/server/services/site-health';
import { ApiError } from '../../../../src/shared/errors';
import { siteHealthSchema, type HealthNodeView } from '../../../../src/shared/health/view';
import {
	HOST,
	ORG,
	SITE,
	TOKEN,
	backupRow,
	ok,
	siteRow,
	workerHealth,
	world,
	type World
} from './site-health-support';

const user: Principal = { kind: 'user', userId: 'usr_1' };
const call = { orgId: ORG, siteId: SITE, principal: user };

const read = (w: World) => readSiteHealth(w.services, call);

const nodeById = (nodes: HealthNodeView[], id: string): HealthNodeView | undefined =>
	nodes.flatMap((node) => [node, ...node.children]).find((node) => node.id === id);

beforeEach(() => resetSiteHealthCache());
afterEach(() => {
	resetSiteHealthServices();
	vi.restoreAllMocks();
});

describe('a healthy answer', () => {
	it('is read through the site hostname with the owner token and no redirects', async () => {
		const w = await world(() => ok(workerHealth()));
		const out = await read(w);

		expect(w.fetched).toHaveLength(1);
		expect(w.fetched[0]?.url).toBe(`https://${HOST}/health`);
		expect(w.fetched[0]?.init.redirect).toBe('manual');
		expect(new Headers(w.fetched[0]?.init.headers).get('authorization')).toBe(
			`Bearer ${TOKEN}`
		);
		expect(out).toMatchObject({
			status: 'healthy',
			level: 'ok',
			reachable: true,
			reason: null,
			step: null,
			observedAt: '2026-11-07T12:00:00.000Z'
		});
		expect(siteHealthSchema.parse(out)).toEqual(out);
		expect(out.nodes.map((node) => node.id)).toEqual(['reconcile', 'supervisor', 'repair']);
		expect(nodeById(out.nodes, 'reconcile.owner-tiers')?.title).toBe(
			'Owner tiers are in place'
		);
	});

	it('says the site is live and that most checks have not been made', async () => {
		const w = await world(() => ok(workerHealth()));
		const { readiness } = await read(w);

		expect(readiness.level).toBe('live');
		expect(readiness.missing[0]).toBe('admin access verified');
		const state = (label: string) => readiness.checks.find((c) => c.label === label)?.state;
		expect(state('the site responds')).toBe('done');
		expect(state('a backup restored in a test')).toBe('open');
		for (const label of [
			'admin access verified',
			'a custom domain verified',
			'HTTPS verified',
			'a critical alert configured with a delivered test notification',
			'a named technical contact',
			'a named billing contact',
			'a named recovery contact'
		]) {
			expect(state(label), label).toBe('not-checked');
		}
	});

	it('writes one audit row that names the operation and no secret', async () => {
		const w = await world(() => ok(workerHealth()));
		await read(w);

		expect(w.audits).toEqual([
			{
				actor: 'user:usr_1',
				action: 'site.owner-token.use',
				target: SITE,
				detail: { keyVersion: 1, operation: 'health.read' }
			}
		]);
	});
});

describe('a degraded answer', () => {
	const finding = {
		code: 'memory.trend_rising',
		severity: 'warn' as const,
		scope: '',
		context: 'memory rose across four samples'
	};

	it('shows the finding with what the site does about it and a short history', async () => {
		const w = await world(() =>
			ok(
				workerHealth({
					findings: [finding],
					ledger: [
						{ ts: 3000, code: finding.code, severity: 2, action: 'reset' },
						{ ts: 2000, code: finding.code, severity: 1, action: '' },
						{ ts: 1000, code: finding.code, severity: 1, action: '' }
					]
				})
			)
		);
		const out = await read(w);
		const node = nodeById(out.nodes, 'supervisor.memory.trend_rising');

		expect(out).toMatchObject({ status: 'attention', level: 'warn', reachable: true });
		expect(node).toMatchObject({
			level: 'warn',
			detail: 'memory rose across four samples',
			handle: 'interpreter-recycle'
		});
		expect(node?.guidance?.text).toBe(
			'The site repairs this on its own once it is safe to. The repair rebuilds cached or temporary pieces and keeps stored data.'
		);
		expect(node?.guidance?.diagnostics).toContainEqual({
			label: 'Repair handle',
			value: 'interpreter-recycle'
		});
		expect(node?.history).toEqual([
			{ state: 'warn', atMs: 1000 },
			{ state: 'error', atMs: 3000 }
		]);
		expect(nodeById(out.nodes, 'repair')?.history).toEqual([{ state: 'reset', atMs: 3000 }]);
	});

	it('says plainly when a finding has no catalogued repair', async () => {
		const w = await world(() =>
			ok(
				workerHealth({
					findings: [{ ...finding, code: 'made.up_code', severity: 'error' }]
				})
			)
		);
		const node = nodeById((await read(w)).nodes, 'supervisor.made.up_code');

		expect(node?.guidance?.text).toBe(
			'No repair is catalogued for this, so a person needs to look at it.'
		);
	});

	it('names a quarantine as stopped changes and promises no button', async () => {
		const w = await world(() =>
			ok(workerHealth({ repair: { rung: 'quarantine', code: 'render.empty', strikes: 3 } }))
		);
		const out = await read(w);
		const node = nodeById(out.nodes, 'repair');

		expect(out).toMatchObject({ status: 'attention', level: 'critical' });
		expect(node?.guidance?.text).toContain('stopped accepting changes');
		expect(node?.guidance?.text).toContain('until a person releases it');
	});

	it('carries a reconcile step the site still owes', async () => {
		const w = await world(() =>
			ok(
				workerHealth({
					reconcile: {
						version: 1,
						packVersion: 2,
						state: 'owed',
						detail: 'tiers missing'
					}
				})
			)
		);
		const out = await read(w);

		expect(out).toMatchObject({ status: 'attention', level: 'warn' });
		expect(nodeById(out.nodes, 'reconcile')).toMatchObject({
			state: 'behind',
			detail: 'version 1 of 2'
		});
		const step = nodeById(out.nodes, 'reconcile.owner-tiers');
		expect(step).toMatchObject({ level: 'warn', state: 'owed', detail: 'tiers missing' });
		expect(step?.guidance?.text).toContain('The site repairs this on its own.');
	});

	it('keeps the site level when the reconcile chain cannot be rebuilt from its answer', async () => {
		const body = workerHealth({
			reconcile: { version: 1, packVersion: 2, state: 'failed', detail: 'attempt 3' }
		});
		const chain = body.tree.nodes.find((node) => node.id === 'reconcile');
		if (chain) chain.detail = 'a line in another format';
		const w = await world(() => ok(body));
		const out = await read(w);

		expect(nodeById(out.nodes, 'reconcile')).toBeUndefined();
		expect(out.level).toBe('error');
		expect(out.status).toBe('attention');
	});

	it('treats an info level as healthy', async () => {
		const w = await world(() =>
			ok(
				workerHealth({
					reconcile: { version: 2, packVersion: 2, state: 'deferred', detail: 'later' }
				})
			)
		);
		expect(await read(w)).toMatchObject({ status: 'healthy', level: 'info' });
	});
});

describe('a site that does not answer well', () => {
	it('reads as not responding, not as an error, when the connection fails', async () => {
		const w = await world(() => {
			throw new TypeError('fetch failed');
		});
		const out = await read(w);

		expect(out).toMatchObject({
			status: 'unreachable',
			level: 'error',
			reachable: false,
			reason: 'The site did not answer.',
			nodes: []
		});
		expect(out.readiness.level).toBe('pending');
		expect(out.readiness.checks.find((c) => c.label === 'the site responds')?.state).toBe(
			'open'
		);
	});

	it('gives up after the timeout', async () => {
		const w = await world(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
			{ timeoutMs: 20 }
		);

		expect(await read(w)).toMatchObject({ status: 'unreachable', reachable: false });
	});

	it('reads a 503 that names a restore step as starting', async () => {
		const w = await world(
			() =>
				new Response('migrating\n', {
					status: 503,
					headers: { 'x-cfw-migrate': '3/12', 'x-cfw-migrate-state': 'running' }
				})
		);
		const out = await read(w);

		expect(out).toMatchObject({
			status: 'starting',
			level: 'info',
			reachable: true,
			step: 'Unpacking the database, part 3 of 12',
			nodes: []
		});
		expect(out.readiness.level).toBe('pending');
	});

	it('reads a first 503 with no chunk yet as starting', async () => {
		const w = await world(
			() => new Response('x', { status: 503, headers: { 'x-cfw-migrate': 'starting' } })
		);
		expect((await read(w)).step).toBe('Unpacking the database');
	});

	it('reads an object reset page as a restart', async () => {
		const w = await world(
			() => new Response('x', { status: 503, headers: { 'x-cfw-object-reset': '1' } })
		);
		expect(await read(w)).toMatchObject({ status: 'starting', step: 'The site is restarting' });
	});

	it('reads any other 503 as not responding', async () => {
		const w = await world(() => new Response('x', { status: 503 }));
		expect(await read(w)).toMatchObject({
			status: 'unreachable',
			reachable: false,
			reason: 'The site answered that it is unavailable.'
		});
	});

	it('reads a 500 as not responding', async () => {
		const w = await world(() => new Response('x', { status: 500 }));
		expect(await read(w)).toMatchObject({
			status: 'unreachable',
			reason: 'The site answered with an error (500).'
		});
	});

	it('reads a restore the site has stored but not replayed as starting, with its tree', async () => {
		const w = await world(() =>
			ok(workerHealth({ import: { state: 'pending', chunk: 4, chunks: 9 } }))
		);
		const out = await read(w);

		expect(out).toMatchObject({
			status: 'starting',
			reachable: true,
			step: 'Restoring a database, part 4 of 9'
		});
		expect(out.nodes.length).toBe(3);
		expect(out.readiness.level).toBe('pending');
	});

	it('does not call a finished restore a start', async () => {
		const w = await world(() =>
			ok(workerHealth({ import: { state: 'applied', chunk: 9, chunks: 9 } }))
		);
		expect((await read(w)).status).toBe('healthy');
	});

	it('says the token no longer works on a 401, without leaking anything', async () => {
		const w = await world(
			() =>
				new Response(`owner token required for ${TOKEN}\n`, {
					status: 401,
					headers: { 'www-authenticate': 'Bearer realm="drupflare"' }
				})
		);
		const out = await read(w);

		expect(out).toMatchObject({
			status: 'unreadable',
			level: 'warn',
			reachable: true,
			reason: 'The site did not accept the access the dashboard holds for it, so its health cannot be read.',
			nodes: []
		});
		expect(JSON.stringify(out)).not.toContain(TOKEN);
	});

	it('refuses to follow a redirect, which would carry the token elsewhere', async () => {
		const w = await world(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://elsewhere.test/' }
				})
		);
		const out = await read(w);

		expect(out).toMatchObject({ status: 'unreadable', reachable: true });
		expect(out.reason).toBe('The site answered the health read with a redirect.');
		expect(w.fetched).toHaveLength(1);
	});

	it('reads a body it cannot understand as unreadable', async () => {
		for (const body of ['not json', JSON.stringify({ tree: 'x' })]) {
			resetSiteHealthCache();
			const w = await world(() => new Response(body, { status: 200 }));
			expect(await read(w), body).toMatchObject({
				status: 'unreadable',
				reachable: true,
				reason: 'The site answered in a form the dashboard could not read.'
			});
		}
	});

	it('reads a route the site does not have as unreadable', async () => {
		const w = await world(() => new Response('not found\n', { status: 404 }));
		expect(await read(w)).toMatchObject({
			status: 'unreadable',
			reason: 'The site answered 404 to the health read.'
		});
	});

	it('does not call a site that is not active', async () => {
		const w = await world(() => ok(workerHealth()), {
			db: { site: siteRow({ state: 'suspended' }) }
		});

		expect(await read(w)).toMatchObject({ status: 'unreachable', reachable: false });
		expect(w.fetched).toEqual([]);
		expect(w.audits).toEqual([]);
	});

	it('does not call a site with no hostname', async () => {
		const w = await world(() => ok(workerHealth()), {
			db: { site: siteRow({ primary_hostname: null }) }
		});

		expect((await read(w)).reason).toBe('This site has no hostname yet.');
		expect(w.fetched).toEqual([]);
	});

	it('does not call a hostname that is not a public name', async () => {
		const w = await world(() => ok(workerHealth()), {
			db: { site: siteRow({ primary_hostname: 'localhost' }) }
		});

		expect((await read(w)).reason).toBe('The hostname of this site is not valid.');
		expect(w.fetched).toEqual([]);
	});

	it('says so when the dashboard holds no token for the site', async () => {
		const w = await world(() => ok(workerHealth()), { sealed: false });
		const out = await read(w);

		expect(out).toMatchObject({ status: 'unreadable', reachable: true });
		expect(out.reason).toBe(
			'The dashboard holds no access for this site, so its health cannot be read.'
		);
		expect(w.fetched).toEqual([]);
	});
});

describe('the owner token', () => {
	it('never appears in the response, the audit rows, the logs or the error text', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => undefined)
		);
		const echo = {
			code: 'render.empty',
			severity: 'critical' as const,
			scope: `/echo/${TOKEN}`,
			context: `the site said ${TOKEN}`
		};
		const answers = [
			() => ok(workerHealth({ findings: [echo] })),
			() => new Response(`${TOKEN}`, { status: 401 }),
			() => new Response(`${TOKEN}`, { status: 503 }),
			() => {
				throw new Error(`failed with ${TOKEN}`);
			}
		];
		for (const answer of answers) {
			resetSiteHealthCache();
			const w = await world(answer);
			const out = await read(w);
			expect(JSON.stringify(out)).not.toContain(TOKEN);
			expect(JSON.stringify(w.audits)).not.toContain(TOKEN);
		}
		const logged = spies.flatMap((spy) => spy.mock.calls.flat());
		expect(JSON.stringify(logged)).not.toContain(TOKEN);
	});

	it('is removed from text the site echoes back inside its answer', async () => {
		const w = await world(() =>
			ok(
				workerHealth({
					findings: [
						{
							code: 'render.empty',
							severity: 'critical',
							scope: '',
							context: `the site said ${TOKEN}`
						}
					]
				})
			)
		);
		const node = nodeById((await read(w)).nodes, 'supervisor.render.empty');

		expect(node?.detail).toBe('the site said [removed]');
	});

	it('does not reach the fetch of a failed unseal', async () => {
		const w = await world(() => ok(workerHealth()));
		for (const row of w.store.rows.values()) row.current.ct = 'A'.repeat(30);
		await expect(read(w)).rejects.toBeDefined();
		expect(w.fetched).toEqual([]);
	});
});

describe('the cache', () => {
	it('answers a second read inside the window without asking the site again', async () => {
		const w = await world(() => ok(workerHealth()));
		const first = await read(w);
		w.clock.now += HEALTH_CACHE_MS - 1;
		const second = await read(w);

		expect(second).toBe(first);
		expect(w.fetched).toHaveLength(1);
		expect(w.audits).toHaveLength(1);
	});

	it('asks again once 15 seconds have passed', async () => {
		const w = await world(() => ok(workerHealth()));
		await read(w);
		w.clock.now += HEALTH_CACHE_MS;
		const later = await read(w);

		expect(w.fetched).toHaveLength(2);
		expect(later.observedAt).toBe('2026-11-07T12:00:15.000Z');
	});

	it('shares one request between callers that arrive together', async () => {
		const w = await world(() => ok(workerHealth()));
		await Promise.all([read(w), read(w), read(w)]);

		expect(w.fetched).toHaveLength(1);
	});

	it('keeps an unreachable answer for the window too', async () => {
		const w = await world(() => {
			throw new TypeError('down');
		});
		await read(w);
		await read(w);

		expect(w.fetched).toHaveLength(1);
	});

	it('does not keep a read that threw', async () => {
		const w = await world(() => ok(workerHealth()));
		const real = w.services.custody;
		let failures = 1;
		w.services.custody = async () => {
			if (failures-- > 0) throw new ApiError('internal', 'custody is down');
			return real();
		};

		await expect(read(w)).rejects.toMatchObject({ code: 'internal' });
		expect((await read(w)).status).toBe('healthy');
	});
});

describe('who can ask', () => {
	it('finds nothing for a site of another organisation, and never calls it', async () => {
		const w = await world(() => ok(workerHealth()));

		await expect(
			readSiteHealth(w.services, { ...call, orgId: 'org_bbbbbbbb' })
		).rejects.toMatchObject({ code: 'not_found' });
		expect(w.fetched).toEqual([]);
		expect(w.audits).toEqual([]);
	});

	it('finds nothing for a site whose create has not finished', async () => {
		const w = await world(() => ok(workerHealth()), { db: { site: null } });

		await expect(read(w)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('answers 501 until boot installs the services', async () => {
		await expect(readSiteHealth(siteHealthServices(), call)).rejects.toMatchObject({
			code: 'not_built'
		});
	});
});

describe('the backup check', () => {
	it('is done when a backup of the site was restored in a test', async () => {
		const w = await world(() => ok(workerHealth()), {
			db: { backups: [backupRow(), backupRow({ id: 'bkp_22222222', verified: 1 })] }
		});
		const { readiness } = await read(w);

		expect(readiness.checks.find((c) => c.label === 'a backup restored in a test')?.state).toBe(
			'done'
		);
		expect(w.db.asked.at(-1)?.orgId).toBe(ORG);
	});

	it('is open while every backup is unverified', async () => {
		const w = await world(() => ok(workerHealth()), { db: { backups: [backupRow()] } });
		const { readiness } = await read(w);

		expect(readiness.checks.find((c) => c.label === 'a backup restored in a test')?.state).toBe(
			'open'
		);
	});

	it('is not checked when the backups cannot be read', async () => {
		const w = await world(() => ok(workerHealth()), { db: { failBackups: true } });
		const { readiness } = await read(w);

		expect(readiness.checks.find((c) => c.label === 'a backup restored in a test')?.state).toBe(
			'not-checked'
		);
	});
});
