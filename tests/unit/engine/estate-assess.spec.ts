import type { InventoryRow } from '@contracts/estate';
import { DEFAULT_CONCURRENCY } from '@drupflare/workforce';
import { describe, expect, it } from 'vitest';
import { estateStoreOf } from '../../../engine/src/adapters/estate-store';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { EstateDeps } from '../../../engine/src/ports';
import {
	planEstateAssess,
	runEstateAssess,
	type EstateAssessInput
} from '../../../engine/src/workflows/estate-assess';
import { aggregate, classifySite, emptyRow, reconcile } from '../../../src/server/domain/estate';
import { ApiError } from '../../../src/shared/errors';
import { ESTATE_SQL } from '../../../src/shared/estate-sql';
import type { PreflightResult } from '../../../src/shared/preflight';
import { Killed, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';
import { fakeSource, fakeSurveyConnector, importDepsOf, sealCredential } from './import-fakes';

const ASSESSMENT = 'asm_testassessment';
const SERVER = 'web1.example.edu';

const answer = (host: string, over: Partial<PreflightResult> = {}): PreflightResult => ({
	url: `https://${host}/`,
	reachable: true,
	cms: 'drupal',
	version: '11.1.2',
	versionSource: null,
	hosting: null,
	signals: [],
	verdict: 'candidate',
	notes: ['n'],
	...over
});

interface Options {
	sites?: number;
	rows?: (index: number) => Partial<InventoryRow>;
	preflight?: (host: string, calls: string[]) => Promise<PreflightResult>;
	access?: boolean;
	credentialExpired?: boolean;
}

async function estateWorld(options: Options = {}) {
	const world = await makeWorld();
	const now = world.clock.now();
	const count = options.sites ?? 20;
	const surveyor = fakeSurveyConnector();
	const built = importDepsOf(world, {
		connector: fakeSource().connector,
		survey: surveyor.connector
	});
	const calls: string[] = [];
	let inFlight = 0;
	let peak = 0;
	const rows = Array.from({ length: count }, (_, i) => ({
		line: i + 2,
		row: {
			...emptyRow(`site${String(i + 1).padStart(2, '0')}.example.edu`),
			...options.rows?.(i + 1)
		} satisfies InventoryRow
	}));
	const sites = await reconcile(rows);
	let credentialId = '';
	if (options.access) {
		credentialId = await sealCredential(world, {
			orgId: world.orgId,
			now,
			expiresAt: options.credentialExpired ? now - 1 : undefined
		});
	}
	const access = JSON.stringify(options.access ? [{ server: SERVER, credentialId }] : []);
	world.sqlite
		.prepare(ESTATE_SQL.insertAssessment)
		.run(world.orgId, ASSESSMENT, world.operationId, 'k1', count, 0, access, 'usr_x', now, now);
	for (const site of sites) {
		world.sqlite
			.prepare(ESTATE_SQL.insertRow)
			.run(
				world.orgId,
				ASSESSMENT,
				site.number,
				site.input.hostname,
				'pending',
				null,
				JSON.stringify(site),
				null,
				null,
				now
			);
	}
	const deps: EstateDeps = {
		...built.deps,
		estate: estateStoreOf((world.ledger as unknown as { db: never }).db),
		preflight: async (host) => {
			calls.push(host);
			inFlight++;
			peak = Math.max(peak, inFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return await (options.preflight?.(host, calls) ?? Promise.resolve(answer(host)));
			} finally {
				inFlight--;
			}
		}
	};
	const input: EstateAssessInput = {
		operationId: world.operationId,
		orgId: world.orgId,
		assessmentId: ASSESSMENT,
		ceilingBytes: 16 * 1024 * 1024
	};
	await begin(world, input, 'estate-1');
	return { world, deps, input, calls, sites, peak: () => peak, surveyor };
}

type Ew = Awaited<ReturnType<typeof estateWorld>>;

async function begin(
	world: Awaited<ReturnType<typeof makeWorld>>,
	input: EstateAssessInput,
	key: string
) {
	const frozen = await freezePlan(planEstateAssess(input));
	await world.store.begin({
		operation: newOperation({
			id: input.operationId,
			orgId: input.orgId,
			idempotencyKey: key,
			frozen,
			verification: 'not-required',
			now: world.clock.now()
		}),
		accountId: null,
		siteId: null
	});
}

const run = (ew: Ew, memo: Memo = new Map(), script: RunnerScript = {}) =>
	runEstateAssess(makeRunner(memo, script).runner, ew.deps, ew.input);

const rowsOf = (ew: Ew) =>
	ew.world.sqlite
		.prepare('SELECT number, state, class, attempts FROM assessment_rows ORDER BY number')
		.all() as { number: number; state: string; class: string | null; attempts: number }[];

const assessmentOf = (ew: Ew) =>
	ew.world.sqlite.prepare('SELECT state, report FROM assessments').get() as {
		state: string;
		report: string | null;
	};

const operationOf = async (ew: Ew) => (await ew.world.store.get(ew.world.operationId))!;

const countsOf = (calls: string[]) => {
	const counts = new Map<string, number>();
	for (const host of calls) counts.set(host, (counts.get(host) ?? 0) + 1);
	return counts;
};

describe('an estate run', () => {
	it('checks twenty sites once each and finishes with a report', async () => {
		const ew = await estateWorld();
		expect(await run(ew)).toEqual({ status: 'succeeded' });
		expect(ew.calls).toHaveLength(20);
		expect([...countsOf(ew.calls).values()].every((n) => n === 1)).toBe(true);
		const operation = await operationOf(ew);
		expect(operation.status).toBe('succeeded');
		expect(operation.steps.map((s) => s.state)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded'
		]);
		const report = JSON.parse(assessmentOf(ew).report!);
		expect(JSON.parse(operation.cursor!)).toEqual(report);
		expect(assessmentOf(ew).state).toBe('finished');
		expect(report.counts.sites).toBe(20);
		expect(
			Object.values(report.counts.byClass).reduce((a: number, b) => a + (b as number), 0)
		).toBe(20);
		expect(
			Object.values(report.counts.byState).reduce((a: number, b) => a + (b as number), 0)
		).toBe(20);
		expect(report.effort).toMatchObject({ value: null, label: 'Not estimated' });
	});

	it('never runs more rows at once than the fleet concurrency', async () => {
		const ew = await estateWorld();
		await run(ew);
		expect(ew.peak()).toBeGreaterThan(1);
		expect(ew.peak()).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
	});

	it('records a public Drupal candidate as needing access, never as ready', async () => {
		const ew = await estateWorld({ sites: 3 });
		await run(ew);
		for (const row of rowsOf(ew)) {
			expect(row).toMatchObject({ state: 'needs access', class: 'information' });
		}
	});

	it('reads WordPress as Not supported yet and an older Drupal as an automatic upgrade', async () => {
		const ew = await estateWorld({
			sites: 3,
			preflight: async (host) =>
				host.startsWith('site01')
					? answer(host, {
							cms: 'wordpress',
							version: null,
							verdict: 'not yet supported'
						})
					: host.startsWith('site02')
						? answer(host, { version: '10.2.0', verdict: 'needs upgrade' })
						: answer(host, { reachable: false, cms: 'unknown', verdict: 'cannot tell' })
		});
		await run(ew);
		const rows = rowsOf(ew);
		expect(rows.map((r) => r.class)).toEqual([
			'unsupported',
			'automatic upgrade',
			'information'
		]);
		expect(rows.map((r) => r.state)).toEqual(['done', 'done', 'needs access']);
	});

	it('treats a refused address as a result for that row and goes on', async () => {
		const ew = await estateWorld({
			sites: 3,
			preflight: async (host) => {
				if (host.startsWith('site02')) {
					throw new ApiError(
						'unprocessable',
						'That address points to a private network.'
					);
				}
				return answer(host);
			}
		});
		expect(await run(ew)).toEqual({ status: 'succeeded' });
		expect(rowsOf(ew).map((r) => r.state)).toEqual([
			'needs access',
			'needs access',
			'needs access'
		]);
		const verdict = JSON.parse(
			(
				ew.world.sqlite
					.prepare('SELECT verdict FROM assessment_rows WHERE number = 2')
					.get() as {
					verdict: string;
				}
			).verdict
		);
		expect(JSON.stringify(verdict)).toContain('private network');
	});
});

describe('the survey', () => {
	const group = (index: number): Partial<InventoryRow> =>
		index <= 2
			? { server: SERVER, docroot: '/var/www/html' }
			: index === 3
				? { server: SERVER }
				: index === 4
					? { server: 'web2.example.edu', docroot: '/var/www/html' }
					: {};

	it('runs for a server group with a key and a folder, and names what the others lack', async () => {
		const ew = await estateWorld({ sites: 5, access: true, rows: group });
		await run(ew);
		const rows = rowsOf(ew);
		expect(rows.slice(0, 2).map((r) => [r.state, r.class])).toEqual([
			['done', 'ready'],
			['done', 'ready']
		]);
		const verdicts = ew.world.sqlite
			.prepare('SELECT number, verdict FROM assessment_rows ORDER BY number')
			.all() as { number: number; verdict: string }[];
		const missing = (n: number) =>
			JSON.parse(verdicts[n - 1]!.verdict).missing as string | null;
		expect(missing(1)).toBeNull();
		expect(missing(3)).toBe('the folder this site lives in, so the survey knows where to look');
		expect(missing(4)).toBe('an SSH key for web2.example.edu, with its host key confirmed');
		expect(missing(5)).toBe('an SSH key for the server this site runs on');
		expect(JSON.parse(verdicts[0]!.verdict).basis).toBe('survey');
	});

	it('sends the server only read commands and closes each session', async () => {
		const ew = await estateWorld({ sites: 2, access: true, rows: group });
		await run(ew);
		expect(ew.surveyor.sessions).toHaveLength(2);
		for (const session of ew.surveyor.sessions) {
			expect(session.closed).toBe(true);
			for (const command of session.commands) {
				expect(command).not.toMatch(/\b(rm|mv|cp|tee|chmod|drop|delete|truncate)\b/i);
			}
		}
	});

	it('stops at needs access when the key has expired', async () => {
		const ew = await estateWorld({
			sites: 2,
			access: true,
			credentialExpired: true,
			rows: group
		});
		await run(ew);
		for (const row of rowsOf(ew)) expect(row.state).toBe('needs access');
		const verdict = JSON.parse(
			(
				ew.world.sqlite
					.prepare('SELECT verdict FROM assessment_rows WHERE number = 1')
					.get() as {
					verdict: string;
				}
			).verdict
		);
		expect(verdict.missing).toBe(
			'a working SSH key for web1.example.edu, with its host key confirmed'
		);
	});
});

describe('a failure at one row', () => {
	it('records row 7 as could not check, runs the rest, and rerunning leaves rows 1 to 6 alone', async () => {
		const ew = await estateWorld({
			preflight: async (host) => {
				if (host.startsWith('site07')) throw new Error('socket hang up');
				return answer(host);
			}
		});
		expect(await run(ew)).toEqual({ status: 'succeeded' });
		const rows = rowsOf(ew);
		expect(rows.filter((r) => r.state === 'could not check').map((r) => r.number)).toEqual([7]);
		expect(rows.filter((r) => r.state === 'needs access')).toHaveLength(19);
		const report = JSON.parse(assessmentOf(ew).report!);
		expect(report.counts.byState['could not check']).toBe(1);

		const before = countsOf(ew.calls);
		expect([...before.values()].every((n) => n === 1)).toBe(true);
		// a retry is a new operation on the same stored rows
		const retry = { ...ew.input, operationId: `op_${'r'.repeat(26)}` };
		await begin(ew.world, retry, 'estate-retry');
		ew.deps.preflight = async (host) => {
			ew.calls.push(host);
			return answer(host);
		};
		expect(await runEstateAssess(makeRunner(new Map()).runner, ew.deps, retry)).toEqual({
			status: 'succeeded'
		});
		const after = countsOf(ew.calls);
		for (let n = 1; n <= 20; n++) {
			const host = `site${String(n).padStart(2, '0')}.example.edu`;
			expect(after.get(host), host).toBe(n === 7 ? 2 : 1);
		}
		expect(rowsOf(ew).find((r) => r.number === 7)).toMatchObject({
			state: 'needs access',
			attempts: 2
		});
		expect(
			rowsOf(ew)
				.filter((r) => r.number !== 7)
				.every((r) => r.attempts === 1)
		).toBe(true);
	});

	it('a row whose step fails for good is recorded and the run still finishes', async () => {
		const ew = await estateWorld({ sites: 10 });
		const outcome = await run(ew, new Map(), { failAt: { step: 'row-7', when: 'before' } });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(rowsOf(ew)[6]).toMatchObject({ state: 'could not check' });
		expect(ew.calls).toHaveLength(9);
		expect(countsOf(ew.calls).has('site07.example.edu')).toBe(false);
	});
});

describe('kill and resume', () => {
	const final = async (ew: Ew) => ({
		rows: rowsOf(ew),
		assessment: assessmentOf(ew),
		operation: (await operationOf(ew)).status
	});

	it('converges to the uninterrupted run after a kill at every step, and checks each site once', async () => {
		const clean = await estateWorld({ sites: 8 });
		await run(clean);
		const expected = await final(clean);
		const steps = 8 + 8;
		let killed = 0;
		for (let k = 0; k <= steps; k++) {
			for (const kind of ['killAfter', 'killDuring'] as const) {
				const ew = await estateWorld({ sites: 8 });
				const memo: Memo = new Map();
				const script: RunnerScript =
					kind === 'killAfter' ? { killAfter: k } : { killDuring: k + 1 };
				const first = await run(ew, memo, script).then(
					(value) => value,
					(error: unknown) => error
				);
				if (first instanceof Killed) {
					killed++;
					expect(await run(ew, memo)).toEqual({ status: 'succeeded' });
				}
				expect(await final(ew), `${kind} ${k}`).toEqual(expected);
				for (const [host, n] of countsOf(ew.calls))
					expect(n, `${kind} ${k} ${host}`).toBe(1);
			}
		}
	});

	it('resumes in a new instance with an empty memo and does not repeat finished rows', async () => {
		const ew = await estateWorld({ sites: 8 });
		await expect(run(ew, new Map(), { killAfter: 7 })).rejects.toBeInstanceOf(Killed);
		const done = ew.calls.length;
		expect(done).toBeGreaterThan(0);
		expect(await run(ew, new Map())).toEqual({ status: 'succeeded' });
		for (const [host, n] of countsOf(ew.calls)) expect(n, host).toBe(1);
		expect(ew.calls).toHaveLength(8);
	});
});

describe('cancel', () => {
	it('skips every row and ends the operation cancelled when it was cancelled before the run', async () => {
		const ew = await estateWorld({ sites: 6 });
		ew.world.sqlite.prepare(ESTATE_SQL.cancel).run(1, ew.world.orgId, ASSESSMENT);
		expect(await run(ew)).toMatchObject({ status: 'cancelled' });
		expect(ew.calls).toEqual([]);
		expect(rowsOf(ew).every((r) => r.state === 'skipped')).toBe(true);
		expect((await operationOf(ew)).status).toBe('cancelled');
		expect(assessmentOf(ew).state).toBe('cancelled');
	});

	it('stops checking new rows once cancelled during the run', async () => {
		const ew = await estateWorld({
			sites: 20,
			preflight: async (host) => {
				if (host.startsWith('site03')) {
					ew.world.sqlite.prepare(ESTATE_SQL.cancel).run(1, ew.world.orgId, ASSESSMENT);
				}
				return answer(host);
			}
		});
		expect(await run(ew)).toMatchObject({ status: 'cancelled' });
		expect(ew.calls.length).toBeLessThan(20);
		const states = new Set(rowsOf(ew).map((r) => r.state));
		expect(states.has('skipped')).toBe(true);
		expect(assessmentOf(ew).state).toBe('cancelled');
		expect(assessmentOf(ew).report).toBeNull();
	});
});

describe('the report', () => {
	it('matches what the domain functions give for the same verdicts', async () => {
		const ew = await estateWorld({ sites: 6 });
		await run(ew);
		const evidence = {
			preflight: answer('x'),
			dossier: null,
			access: 'none' as const,
			needsProof: null
		};
		const expected = aggregate(
			ew.sites.map((site) => ({ site, verdict: classifySite(site, evidence) }))
		);
		expect(JSON.parse(assessmentOf(ew).report!).counts.byClass).toEqual(
			expected.counts.byClass
		);
	});
});
