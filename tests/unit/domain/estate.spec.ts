import { ESTATE_LIMITS, ROW_CLASSES, type InventoryRow } from '@contracts/estate';
import { describe, expect, it } from 'vitest';
import {
	aggregate,
	classifySite,
	emptyRow,
	parseCsv,
	parseInventory,
	proofAllowance,
	reconcile,
	sourceSiteIdOf,
	toCsv,
	type EstateSite,
	type Evidence
} from '../../../src/server/domain/estate';

// a small seeded generator, so the property runs are the same on every machine
function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const shuffle = <T>(items: T[], next: () => number): T[] => {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
};

const row = (host: string, over: Partial<InventoryRow> = {}): InventoryRow => ({
	...emptyRow(host),
	...over
});

const NONE: Evidence = { preflight: null, dossier: null, access: 'none', needsProof: null };

const strip = (sites: EstateSite[]) =>
	sites.map(({ lines: _lines, number: _number, ...rest }) => rest);

describe('parseInventory', () => {
	it('reads a CSV with quoted cells, CRLF and a byte order mark', () => {
		const text =
			'﻿hostname,aliases,owner_note\r\nA.example.edu,"b.example.edu;c.example.edu","says ""hi"", twice"\r\n';
		const parsed = parseInventory(text);
		expect(parsed.fileError).toBeNull();
		expect(parsed.rows).toHaveLength(1);
		expect(parsed.rows[0]!.row.hostname).toBe('a.example.edu');
		expect(parsed.rows[0]!.row.aliases).toEqual(['b.example.edu', 'c.example.edu']);
		expect(parsed.rows[0]!.row.ownerNote).toBe('says "hi", twice');
	});

	it('reads JSON as a bare list or under sites, in camel or snake case', () => {
		const one = parseInventory(JSON.stringify([{ hostname: 'a.example.edu', siteDir: 'x' }]));
		const two = parseInventory(
			JSON.stringify({
				sites: [{ Hostname: 'a.example.edu', site_dir: 'x', aliases: ['b.example.edu'] }]
			})
		);
		expect(one.rows[0]!.row.siteDir).toBe('x');
		expect(two.rows[0]!.row.siteDir).toBe('x');
		expect(two.rows[0]!.row.aliases).toEqual(['b.example.edu']);
	});

	it('reports each rejected row with its line and a plain reason, and keeps the rest', () => {
		const text = [
			'hostname,cms',
			'ok.example.edu,drupal',
			',drupal',
			'10.0.0.1,drupal',
			'bad_name.example.edu,drupal',
			'fine.example.edu,magento'
		].join('\n');
		const parsed = parseInventory(text);
		expect(parsed.rows.map((r) => r.line)).toEqual([2]);
		expect(parsed.rejected).toEqual([
			{ line: 3, reason: 'missing hostname' },
			{ line: 4, reason: 'hostname is an IP address' },
			{ line: 5, reason: 'hostname is not a valid public name' },
			{ line: 6, reason: 'cms is not drupal, wordpress, joomla or unknown' }
		]);
	});

	it('numbers a row after a multi-line quoted cell by the line it starts on', () => {
		const text = 'hostname,owner_note\na.example.edu,"two\nlines"\nb.example.edu,x\n';
		const parsed = parseInventory(text);
		expect(parsed.rows.map((r) => r.line)).toEqual([2, 4]);
	});

	it('reports an unknown column once and ignores it', () => {
		const parsed = parseInventory('hostname,mystery\na.example.edu,1\nb.example.edu,2');
		expect(parsed.ignoredColumns).toEqual(['mystery']);
		expect(parsed.rows).toHaveLength(2);
	});

	it('refuses a whole file it cannot read, without throwing', () => {
		const cases: [string, string][] = [
			['', 'The file is empty.'],
			['   \n', 'The file is empty.'],
			['{"sites": [', 'The file is not valid JSON.'],
			['{"other": []}', 'The JSON needs a "sites" list.'],
			['name,owner\nx,y', 'The first row needs a hostname column.'],
			['hostname\n"never closes', 'The file has a quote that never closes.'],
			['hostname\n\u0000\u0001', 'The file does not look like text.'],
			['x'.repeat(ESTATE_LIMITS.textBytes + 1), 'The file is larger than 1 MiB.']
		];
		for (const [input, reason] of cases) {
			const parsed = parseInventory(input);
			expect(parsed.fileError, input.slice(0, 20)).toBe(reason);
			expect(parsed.rows).toEqual([]);
		}
	});

	it('never throws on random bytes', () => {
		const next = rng(7);
		for (let i = 0; i < 300; i++) {
			const length = Math.floor(next() * 120);
			let text = '';
			for (let j = 0; j < length; j++) text += String.fromCharCode(Math.floor(next() * 256));
			expect(() => parseInventory(text)).not.toThrow();
		}
	});

	it('stops at the row limit and says where', () => {
		const lines = ['hostname'];
		for (let i = 0; i < ESTATE_LIMITS.rows + 3; i++) lines.push(`h${i}.example.edu`);
		const parsed = parseInventory(lines.join('\n'));
		expect(parsed.rows).toHaveLength(ESTATE_LIMITS.rows);
		expect(parsed.rejectedTotal).toBe(3);
		expect(parsed.rejected[0]!.reason).toContain('more than 1000 rows');
	});

	it('caps the rejected list but counts them all', () => {
		const lines = ['hostname'];
		for (let i = 0; i < 300; i++) lines.push('10.0.0.1');
		const parsed = parseInventory(lines.join('\n'));
		expect(parsed.rejected).toHaveLength(ESTATE_LIMITS.rejectedShown);
		expect(parsed.rejectedTotal).toBe(300);
	});

	it('rejects a bad alias, too many aliases and a bad UUID', () => {
		const many = Array.from({ length: 41 }, (_, i) => `a${i}.example.edu`).join(';');
		const parsed = parseInventory(
			`hostname,aliases,site_uuid\na.example.edu,10.0.0.9,\nb.example.edu,${many},\nc.example.edu,,zzzz`
		);
		expect(parsed.rejected.map((r) => r.reason)).toEqual([
			'alias 10.0.0.9: hostname is an IP address',
			'more than 40 aliases',
			'site_uuid is not a UUID'
		]);
	});

	it('parses bare CSV records', () => {
		expect(parseCsv('a,b\n1,2')).toEqual([
			{ line: 1, cells: ['a', 'b'] },
			{ line: 2, cells: ['1', '2'] }
		]);
		expect(parseCsv('"x')).toBeNull();
	});
});

describe('reconcile', () => {
	const base = [
		{
			line: 2,
			row: row('a.example.edu', { siteUuid: '11111111-aaaa-bbbb-cccc-000000000001' })
		},
		{
			line: 3,
			row: row('alias-of-a.example.edu', {
				siteUuid: '11111111-aaaa-bbbb-cccc-000000000001',
				docroot: '/var/www/a'
			})
		},
		{
			line: 4,
			row: row('b.example.edu', {
				server: 'web1.example.edu',
				siteDir: 'b',
				databaseHost: 'db1',
				databaseName: 'shared'
			})
		},
		{
			line: 5,
			row: row('c.example.edu', {
				server: 'web1.example.edu',
				siteDir: 'c',
				databaseHost: 'db1',
				databaseName: 'shared'
			})
		},
		{ line: 6, row: row('d.example.edu') },
		{ line: 7, row: row('d.example.edu') }
	];

	it('treats two aliases of one site as one row and keeps both names', async () => {
		const sites = await reconcile(base);
		const a = sites.find((s) => s.input.hostname === 'a.example.edu')!;
		expect(a.input.aliases).toEqual(['alias-of-a.example.edu']);
		expect(a.input.docroot).toBe('/var/www/a');
		expect(a.lines).toEqual([2, 3]);
		expect(a.reconciled).toBe(true);
	});

	it('keeps two sites on one database as two rows that both name the shared database', async () => {
		const sites = await reconcile(base);
		const b = sites.find((s) => s.input.hostname === 'b.example.edu')!;
		const c = sites.find((s) => s.input.hostname === 'c.example.edu')!;
		expect(b.key).not.toBe(c.key);
		for (const [site, other] of [
			[b, c],
			[c, b]
		] as const) {
			const finding = site.findings.find((f) => f.title === 'Shared Database')!;
			expect(finding.status).toBe('requires choice');
			expect(finding.detail).toContain(`row ${other.number}`);
		}
	});

	it('labels a hostname-only row as not reconciled and merges an exact repeat', async () => {
		const sites = await reconcile(base);
		const d = sites.filter((s) => s.input.hostname === 'd.example.edu');
		expect(d).toHaveLength(1);
		expect(d[0]!.reconciled).toBe(false);
		expect(d[0]!.basis).toBe('hostname');
	});

	it('reports a duplicate domain once on the first row and points the second at it', async () => {
		const sites = await reconcile([
			{
				line: 2,
				row: row('x.example.edu', { siteUuid: '22222222-aaaa-bbbb-cccc-000000000001' })
			},
			{
				line: 3,
				row: row('y.example.edu', {
					aliases: ['x.example.edu'],
					siteUuid: '22222222-aaaa-bbbb-cccc-000000000002'
				})
			}
		]);
		const dupes = sites
			.flatMap((s) => s.findings)
			.filter((f) => f.title === 'Duplicate Domain');
		expect(dupes).toHaveLength(2);
		expect(dupes.filter((f) => f.status === 'requires choice')).toHaveLength(1);
		expect(sites[0]!.findings[0]!.detail).toContain('rows 1, 2');
		expect(
			aggregate(sites.map((site) => ({ site, verdict: classifySite(site, NONE) }))).counts
				.duplicateDomains
		).toBe(1);
	});

	it('does not depend on the order rows arrive in', async () => {
		const expected = strip(await reconcile(base));
		const next = rng(42);
		for (let i = 0; i < 25; i++) {
			expect(strip(await reconcile(shuffle(base, next)))).toEqual(expected);
		}
	});

	it('is idempotent: reconciling its own output changes nothing', async () => {
		const first = await reconcile(base);
		const second = await reconcile(
			first.map((site) => ({ line: site.lines[0]!, row: site.input }))
		);
		expect(strip(second)).toEqual(strip(first));
		const third = await reconcile(
			second.map((site) => ({ line: site.lines[0]!, row: site.input }))
		);
		expect(strip(third)).toEqual(strip(second));
	});

	it('hashes host, docroot, database endpoint and site directory out of the id', async () => {
		const id = await sourceSiteIdOf(
			row('a.example.edu', {
				server: 'web1.example.edu',
				docroot: '/var/www/secret',
				siteDir: 'default',
				databaseHost: 'db.internal'
			})
		);
		const text = JSON.stringify(id);
		for (const word of ['web1.example.edu', '/var/www/secret', 'db.internal']) {
			expect(text).not.toContain(word);
		}
		expect(id.hostFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it('survives a randomised estate: totals equal the row counts', async () => {
		const next = rng(99);
		const rows: { line: number; row: InventoryRow }[] = [];
		for (let i = 0; i < 80; i++) {
			const n = Math.floor(next() * 30);
			rows.push({
				line: i + 2,
				row: row(`h${n}.example.edu`, {
					databaseHost: next() > 0.5 ? 'db1' : '',
					databaseName: `db${Math.floor(next() * 5)}`,
					server: 'web',
					siteDir: `d${n}`,
					cms: next() > 0.8 ? 'wordpress' : 'drupal'
				})
			});
		}
		const sites = await reconcile(rows);
		const report = aggregate(
			sites.map((site) => ({ site, verdict: classifySite(site, NONE) }))
		);
		const byClass = Object.values(report.counts.byClass).reduce((a, b) => a + b, 0);
		const byState = Object.values(report.counts.byState).reduce((a, b) => a + b, 0);
		expect(report.counts.sites).toBe(sites.length);
		expect(byClass).toBe(sites.length);
		expect(byState).toBe(sites.length);
		expect(new Set(sites.map((s) => s.number)).size).toBe(sites.length);
	});
});

describe('classifySite', () => {
	const site = async (over: Partial<InventoryRow> = {}) =>
		(await reconcile([{ line: 2, row: row('a.example.edu', over) }]))[0]!;
	const dossier = (over: Record<string, unknown>) =>
		({
			verdict: 'ready',
			importable: true,
			refusals: [],
			estimate: { bytes: 1, fileCount: 1 },
			findings: [{ status: 'automatic', title: 'Drupal Version', detail: 'x' }],
			...over
		}) as unknown as Evidence['dossier'];
	const preflight = (over: Record<string, unknown>) =>
		({
			url: 'https://a.example.edu/',
			reachable: true,
			cms: 'drupal',
			version: null,
			versionSource: null,
			hosting: null,
			signals: [],
			verdict: 'candidate',
			notes: ['n'],
			...over
		}) as unknown as Evidence['preflight'];

	it('calls a surveyed Drupal 11 site ready', async () => {
		const v = classifySite(await site(), { ...NONE, dossier: dossier({}) });
		expect(v).toMatchObject({
			class: 'ready',
			state: 'done',
			basis: 'survey',
			reconciled: true
		});
	});

	it('maps a Needs Upgrade dossier to automatic upgrade', async () => {
		const v = classifySite(await site(), {
			...NONE,
			dossier: dossier({ verdict: 'needs upgrade', importable: false })
		});
		expect(v.class).toBe('automatic upgrade');
	});

	it('maps a refused dossier to unsupported and keeps each refusal', async () => {
		const v = classifySite(await site(), {
			...NONE,
			dossier: dossier({
				verdict: 'refused',
				refusals: ['A pgsql database cannot be imported']
			})
		});
		expect(v.class).toBe('unsupported');
		expect(v.findings.map((f) => f.detail)).toContain('A pgsql database cannot be imported');
	});

	it('maps a requires-choice finding to needs decision', async () => {
		const v = classifySite(await site(), {
			...NONE,
			dossier: dossier({
				findings: [{ status: 'requires choice', title: 'Redis Data', detail: 'r' }]
			})
		});
		expect(v.class).toBe('needs decision');
	});

	it('says WordPress is not supported yet, from the page or from the inventory', async () => {
		const fromPage = classifySite(await site(), {
			...NONE,
			preflight: preflight({ cms: 'wordpress', verdict: 'not yet supported' })
		});
		const fromColumns = classifySite(await site({ cms: 'wordpress' }), NONE);
		for (const v of [fromPage, fromColumns]) {
			expect(v.class).toBe('unsupported');
			expect(v.findings[0]!.detail).toContain('Not supported yet');
		}
	});

	it('never calls a public candidate ready and names the access it lacks', async () => {
		const v = classifySite(await site({ server: 'web1.example.edu' }), {
			...NONE,
			preflight: preflight({ version: '11.1.0' })
		});
		expect(v).toMatchObject({ class: 'information', state: 'needs access' });
		expect(v.missing).toBe('an SSH key for web1.example.edu, with its host key confirmed');
		const noServer = classifySite(await site(), { ...NONE, preflight: preflight({}) });
		expect(noServer.missing).toBe('an SSH key for the server this site runs on');
	});

	it('reads a printed older version as an automatic upgrade and a newer one as unsupported', async () => {
		const old = classifySite(await site(), {
			...NONE,
			preflight: preflight({ version: '10.3.1' })
		});
		const future = classifySite(await site(), {
			...NONE,
			preflight: preflight({ version: '12.0.0' })
		});
		expect(old.class).toBe('automatic upgrade');
		expect(old.state).toBe('done');
		expect(future.class).toBe('unsupported');
		const declared = classifySite(await site({ cms: 'drupal', version: '9.5.0' }), NONE);
		expect(declared.class).toBe('automatic upgrade');
	});

	it('records an unreachable site and a site that hides its system as information', async () => {
		const down = classifySite(await site(), {
			...NONE,
			preflight: preflight({ reachable: false, cms: 'unknown', verdict: 'cannot tell' })
		});
		expect(down.findings.some((f) => f.title === 'Did Not Answer')).toBe(true);
		expect(down.class).toBe('information');
	});

	it('stops a site on an unproven domain at needs proof', async () => {
		const v = classifySite(await site(), { ...NONE, needsProof: 'example.edu' });
		expect(v).toMatchObject({ class: 'information', state: 'needs proof' });
		expect(v.missing).toBe('proof that you control example.edu');
	});

	it('lets a shared database outrank ready but not unsupported', async () => {
		const [a, b] = await reconcile([
			{
				line: 2,
				row: row('a.example.edu', {
					databaseHost: 'db',
					databaseName: 's',
					siteDir: 'a',
					server: 'w'
				})
			},
			{
				line: 3,
				row: row('b.example.edu', {
					databaseHost: 'db',
					databaseName: 's',
					siteDir: 'b',
					server: 'w'
				})
			}
		]);
		expect(classifySite(a!, { ...NONE, dossier: dossier({}) }).class).toBe('needs decision');
		expect(
			classifySite(b!, { ...NONE, dossier: dossier({ verdict: 'refused', refusals: ['x'] }) })
				.class
		).toBe('unsupported');
	});
});

describe('proofAllowance', () => {
	it('checks the first sites on unproven domains and holds the rest', async () => {
		const rows = Array.from({ length: 8 }, (_, i) => ({
			line: i + 2,
			row: row(`s${i}.other.edu`)
		}));
		rows.push({ line: 20, row: row('www.mine.edu') });
		const sites = await reconcile(rows);
		const allowed = proofAllowance(sites, new Set(['mine.edu']));
		const held = [...allowed.values()].filter((v) => v !== null);
		expect(held).toHaveLength(3);
		expect(held[0]).toBe('other.edu');
		expect(
			allowed.get(sites.find((s) => s.input.hostname === 'www.mine.edu')!.number)
		).toBeNull();
	});
});

describe('toCsv', () => {
	it('exports a file that imports again with nothing lost', async () => {
		const sites = await reconcile([
			{
				line: 2,
				row: row('a.example.edu', {
					aliases: ['z.example.edu'],
					server: 'web1',
					docroot: '/var/www/a',
					siteDir: 'default',
					databaseHost: 'db1',
					databaseName: 'a,b',
					tablePrefix: 'x_',
					siteUuid: '33333333-aaaa-bbbb-cccc-000000000001',
					cms: 'drupal',
					version: '11.0.1',
					ownerNote: '=SUM(1)\nsecond "line"'
				})
			},
			{ line: 3, row: row('b.example.edu') }
		]);
		const rows = sites.map((s) => ({ site: s, verdict: classifySite(s, NONE) }));
		const csv = toCsv(rows);
		expect(csv).toContain("'=SUM(1)");
		const again = parseInventory(csv);
		expect(again.fileError).toBeNull();
		expect(again.ignoredColumns).toEqual([]);
		const second = await reconcile(again.rows);
		expect(strip(second)).toEqual(strip(sites));
	});

	it('writes Not reconciled and Not estimated where they apply', async () => {
		const sites = await reconcile([{ line: 2, row: row('a.example.edu') }]);
		const csv = toCsv(sites.map((s) => ({ site: s, verdict: classifySite(s, NONE) })));
		expect(csv).toContain('Not reconciled');
		expect(csv).toContain('Not estimated');
	});
});

describe('aggregate', () => {
	it('states effort and windows as not estimated, with no number', async () => {
		const sites = await reconcile([{ line: 2, row: row('a.example.edu') }]);
		const report = aggregate(sites.map((s) => ({ site: s, verdict: classifySite(s, NONE) })));
		expect(report.effort).toMatchObject({ value: null, label: 'Not estimated' });
		expect(report.windows).toEqual({ value: null, label: 'Not estimated' });
		expect(Object.keys(report.counts.byClass)).toEqual([...ROW_CLASSES]);
	});
});
