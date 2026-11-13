import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	MAX_FOUND_PER_FRAME,
	NEW_SITE_GRACE_MS,
	boxToken,
	frameDigest,
	isBoxToken,
	nameForHost,
	neutralName,
	reconcileBoxSites,
	tokensFor,
	type BoxFrame,
	type BoxSiteChanges,
	type BoxSiteInput,
	type KnownBoxSite
} from '../../../src/server/domain/box-sites';

const NODE = 'nod_boxtest00001';
const OTHER_NODE = 'nod_boxtest00002';
const NOW = 1_800_000_000_000;
const OLD = NOW - 2 * NEW_SITE_GRACE_MS;

// the bastion's own rule for a hashed name, written out again here so a drift in either shows up
const bastionToken = (nodeId: string, host: string) =>
	`h:${createHash('sha256').update(`${nodeId}\n${host}`).digest('hex').slice(0, 24)}`;

const fakeToken = (host: string) => bastionToken(NODE, host);

const known = (patch: Partial<KnownBoxSite> & { id: string }): KnownBoxSite => ({
	name: patch.id,
	host: null,
	foundAs: null,
	nodeId: NODE,
	state: 'active',
	readyAt: OLD,
	missingSince: null,
	...patch
});

const clear = (...names: string[]): BoxFrame => ({ names, hashed: false });

function run(
	rows: KnownBoxSite[],
	frame: BoxFrame,
	patch: Partial<BoxSiteInput> = {}
): BoxSiteChanges {
	return reconcileBoxSites({
		nodeId: NODE,
		nodeLabel: 'campus-box',
		known: rows,
		frame,
		tokenOf: fakeToken,
		now: NOW,
		...patch
	});
}

// what the store does with an answer, enough to feed it back in
function apply(rows: KnownBoxSite[], changes: BoxSiteChanges, nodeId = NODE): KnownBoxSite[] {
	let counter = 0;
	const created = changes.create.map((found): KnownBoxSite => ({
		id: `made_${counter++}_${found.foundAs}`,
		name: found.name,
		host: found.host,
		foundAs: found.foundAs,
		nodeId,
		state: 'active',
		readyAt: NOW,
		missingSince: null
	}));
	const next = rows.map((row): KnownBoxSite => {
		const learned = changes.learn.find((item) => item.id === row.id);
		const named = learned ? { ...row, host: learned.host, foundAs: learned.host } : row;
		if (changes.markMissing.includes(row.id)) return { ...named, missingSince: NOW };
		if (changes.markPresent.includes(row.id)) return { ...named, missingSince: null };
		return named;
	});
	return [...next, ...created];
}

const quiet = (changes: BoxSiteChanges): boolean =>
	changes.create.length === 0 &&
	changes.learn.length === 0 &&
	changes.markMissing.length === 0 &&
	changes.markPresent.length === 0;

function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
	}
	return copy;
}

describe('boxToken', () => {
	it('is the digest the bastion computes over the node id and the host', async () => {
		for (const host of ['www.example.edu', 'a.b.example.org']) {
			expect(await boxToken(NODE, host)).toBe(bastionToken(NODE, host));
		}
		expect(isBoxToken(await boxToken(NODE, 'x.example.org'))).toBe(true);
		expect(isBoxToken('h:short')).toBe(false);
		expect(isBoxToken('www.example.org')).toBe(false);
	});

	it('differs per node, so one box cannot match another box hash', async () => {
		expect(await boxToken(NODE, 'x.example.org')).not.toBe(
			await boxToken(OTHER_NODE, 'x.example.org')
		);
	});
});

describe('naming a found site', () => {
	it('turns a host into one lowercase label of letters, numbers and single hyphens', () => {
		expect(nameForHost('www.Example.edu', 'campus-box', new Set())).toBe('www-example-edu');
		expect(nameForHost('a.b--c.example.org', 'box', new Set())).toBe('a-b-c-example-org');
	});

	it('gives a collision the node name as a suffix, then a count, never a random word', () => {
		const taken = new Set(['www-example-edu']);
		expect(nameForHost('www.example.edu', 'Campus Box', taken)).toBe(
			'www-example-edu-campus-box'
		);
		taken.add('www-example-edu-campus-box');
		expect(nameForHost('www.example.edu', 'Campus Box', taken)).toBe(
			'www-example-edu-campus-box-2'
		);
	});

	it('refuses the reserved endings and words the way a custom name is refused', () => {
		expect(nameForHost('blog.dev', 'box', new Set())).toBe('blog-dev-box');
		expect(nameForHost('api.example.org', 'box', new Set())).toBe('api-example-org');
		expect(nameForHost('app', 'box', new Set())).toBe('app-box');
	});

	it('cuts a long host to the name limit and still fits the suffix', () => {
		const host = `${'a'.repeat(60)}.example.org`;
		const plain = nameForHost(host, 'campus-box', new Set());
		expect(plain!.length).toBeLessThanOrEqual(63);
		const name = nameForHost(host, 'campus-box', new Set([plain!]));
		expect(name).not.toBeNull();
		expect(name!.length).toBeLessThanOrEqual(63);
		expect(name).toMatch(/-campus-box$/);
	});

	it('numbers a neutral name from the smallest free count', () => {
		expect(neutralName('Campus Box', new Set())).toBe('Site 1 on Campus Box');
		expect(neutralName('Campus Box', new Set(['Site 1 on Campus Box']))).toBe(
			'Site 2 on Campus Box'
		);
	});
});

describe('reconcileBoxSites', () => {
	it('creates a found site for a host the dashboard has no row for, named from the host', () => {
		const changes = run([], clear('www.example.edu'));
		expect(changes.create).toEqual([
			{ name: 'www-example-edu', host: 'www.example.edu', foundAs: 'www.example.edu' }
		]);
		expect(changes).toMatchObject({ markMissing: [], markPresent: [], skipped: 0, ignored: 0 });
	});

	it('matches a row by its host, in any case, and creates nothing', () => {
		const rows = [known({ id: 'site_a', host: 'www.example.edu' })];
		expect(quiet(run(rows, clear('WWW.Example.edu.')))).toBe(true);
	});

	it('creates one row for a name the frame lists twice, and counts a name it cannot use', () => {
		const changes = run(
			[],
			clear('a.example.org', 'A.EXAMPLE.ORG', 'not a host', '*.example.org')
		);
		expect(changes.create).toHaveLength(1);
		expect(changes.ignored).toBe(2);
	});

	it('leaves a platform address and an invalid host out', () => {
		const changes = run([], clear('x.drupflare.app', 'under_score.example.org'));
		expect(changes.create).toEqual([]);
		expect(changes.ignored).toBe(2);
	});

	it('names a colliding host with the node name and never takes a taken name', () => {
		const rows = [known({ id: 'site_a', name: 'www-example-edu', host: 'old.example.org' })];
		const changes = run(rows, clear('www.example.edu', 'www-example.edu'));
		expect(changes.create.map((item) => item.name)).toEqual([
			'www-example-edu-campus-box',
			'www-example-edu-campus-box-2'
		]);
	});

	it('does not read a deleted row as taking its name', () => {
		const rows = [known({ id: 'site_a', name: 'www-example-edu', state: 'deleted' })];
		expect(run(rows, clear('www.example.edu')).create[0]?.name).toBe('www-example-edu');
	});

	it('marks a listed site the box stopped reporting, once', () => {
		const rows = [known({ id: 'site_a', host: 'www.example.edu' })];
		const first = run(rows, clear());
		expect(first.markMissing).toEqual(['site_a']);
		const second = run(apply(rows, first), clear());
		expect(second).toMatchObject({ markMissing: [], unchanged: ['site_a'] });
	});

	it('clears the mark when the box reports the site again', () => {
		const rows = [known({ id: 'site_a', host: 'www.example.edu', missingSince: NOW - 5000 })];
		const changes = run(rows, clear('www.example.edu'));
		expect(changes.markPresent).toEqual(['site_a']);
		expect(changes.create).toEqual([]);
	});

	it('gives a site the dashboard just made or found a grace period before it reads as gone', () => {
		const rows = [
			known({ id: 'site_a', host: 'a.example.org', readyAt: NOW - NEW_SITE_GRACE_MS + 1 }),
			known({ id: 'site_b', host: 'b.example.org', readyAt: NOW - NEW_SITE_GRACE_MS })
		];
		const changes = run(rows, clear());
		expect(changes.markMissing).toEqual(['site_b']);
		expect(changes.unchanged).toEqual(['site_a']);
	});

	it('does not flag a site whose create has not finished, and does not create a second row for it', () => {
		const rows = [known({ id: 'site_a', host: 'new.example.org', readyAt: null })];
		const changes = run(rows, clear('new.example.org'));
		expect(quiet(changes)).toBe(true);
		expect(quiet(run(rows, clear()))).toBe(true);
	});

	it('flags only the rows bound to this node, and counts the rows of another node as listed', () => {
		const rows = [
			known({ id: 'site_a', host: 'a.example.org', nodeId: OTHER_NODE }),
			known({ id: 'site_b', host: 'b.example.org', nodeId: null }),
			known({ id: 'site_c', host: 'c.example.org' })
		];
		const gone = run(rows, clear());
		expect(gone.markMissing).toEqual(['site_c']);
		expect(quiet(run(rows, clear('a.example.org', 'b.example.org', 'c.example.org')))).toBe(
			true
		);
	});

	it('leaves a suspended site flagged like an active one and a tombstoned one alone', () => {
		const rows = [
			known({ id: 'site_a', host: 'a.example.org', state: 'suspended' }),
			known({ id: 'site_b', host: 'b.example.org', state: 'tombstoned' })
		];
		const changes = run(rows, clear());
		expect(changes.markMissing).toEqual(['site_a']);
		expect(changes.create).toEqual([]);
		expect(run(rows, clear('b.example.org')).create).toHaveLength(1);
	});

	it('does not bring a site the owner removed back, found or not', () => {
		const rows = [
			known({
				id: 'site_a',
				host: 'a.example.org',
				foundAs: 'a.example.org',
				state: 'deleted'
			}),
			known({ id: 'site_b', host: 'b.example.org', state: 'deleted' })
		];
		const changes = run(rows, clear('a.example.org', 'b.example.org'));
		expect(changes.create.map((item) => item.host)).toEqual(['b.example.org']);
	});

	it('caps the rows made in one frame and counts the ones left', () => {
		const names = Array.from(
			{ length: 40 },
			(_, i) => `s${String(i).padStart(2, '0')}.example.org`
		);
		const changes = run([], clear(...names));
		expect(changes.create).toHaveLength(MAX_FOUND_PER_FRAME);
		expect(changes.skipped).toBe(40 - MAX_FOUND_PER_FRAME);
		const next = run(apply([], changes), clear(...names));
		expect(next.create).toHaveLength(40 - MAX_FOUND_PER_FRAME);
		expect(next.skipped).toBe(0);
		expect(quiet(run(apply(apply([], changes), next), clear(...names)))).toBe(true);
	});

	it('honours a smaller cap', () => {
		const changes = run([], clear('a.example.org', 'b.example.org'), { maxCreate: 1 });
		expect(changes.create).toHaveLength(1);
		expect(changes.skipped).toBe(1);
	});
});

describe('a box that hashes its names', () => {
	const hashed = (...hosts: string[]): BoxFrame => ({
		names: hosts.map((host) => fakeToken(host)),
		hashed: true
	});

	it('makes a neutral row for a name it cannot read and never invents a host', () => {
		const frame = hashed('a.example.org', 'b.example.org');
		const changes = run([], frame);
		expect(changes.create).toEqual([
			{
				name: 'Site 1 on campus-box',
				host: null,
				foundAs: fakeToken('a.example.org')
			},
			{
				name: 'Site 2 on campus-box',
				host: null,
				foundAs: fakeToken('b.example.org')
			}
		]);
	});

	it('matches a row the dashboard knows by the hash of its host', () => {
		const rows = [known({ id: 'site_a', host: 'a.example.org' })];
		expect(quiet(run(rows, hashed('a.example.org')))).toBe(true);
		expect(run(rows, hashed('b.example.org')).markMissing).toEqual(['site_a']);
	});

	it('matches a found row by the hash it was found under, and numbers new ones past it', () => {
		const rows = [
			known({
				id: 'site_a',
				name: 'Site 1 on campus-box',
				foundAs: fakeToken('a.example.org')
			})
		];
		const frame = hashed('a.example.org', 'b.example.org');
		const changes = run(rows, frame);
		expect(changes.create).toEqual([
			{ name: 'Site 2 on campus-box', host: null, foundAs: fakeToken('b.example.org') }
		]);
	});

	it('drops a name that is not a token and counts it', () => {
		const changes = run([], { names: ['www.example.edu', 'h:xyz'], hashed: true });
		expect(changes).toMatchObject({ create: [], ignored: 2 });
	});

	it('learns the host when the box stops hashing, and does not make a second row', () => {
		const rows = [
			known({
				id: 'site_a',
				name: 'Site 1 on campus-box',
				foundAs: fakeToken('a.example.org')
			})
		];
		const changes = run(rows, clear('a.example.org'));
		expect(changes.learn).toEqual([{ id: 'site_a', host: 'a.example.org' }]);
		expect(changes.create).toEqual([]);
		expect(quiet(run(apply(rows, changes), clear('a.example.org')))).toBe(true);
		expect(quiet(run(apply(rows, changes), hashed('a.example.org')))).toBe(true);
	});

	it('does not learn a host for a row of another node or one that already has one', () => {
		const rows = [
			known({ id: 'site_a', nodeId: OTHER_NODE, foundAs: fakeToken('a.example.org') }),
			known({ id: 'site_b', host: 'b.example.org', foundAs: fakeToken('b.example.org') })
		];
		expect(run(rows, clear('a.example.org', 'b.example.org')).learn).toEqual([]);
	});
});

describe('properties', () => {
	const hosts = Array.from({ length: 12 }, (_, i) => `site${i}.example.org`);

	function world(next: () => number) {
		const rows: KnownBoxSite[] = [];
		for (const host of hosts) {
			const draw = next();
			if (draw < 0.2) continue;
			rows.push(
				known({
					id: `site_${host}`,
					name: host.split('.')[0]!,
					host: draw < 0.7 ? host : null,
					foundAs: draw >= 0.5 ? (draw < 0.7 ? host : fakeToken(host)) : null,
					nodeId: draw > 0.95 ? OTHER_NODE : NODE,
					missingSince: draw > 0.8 ? NOW - 1000 : null,
					readyAt: draw > 0.9 ? NOW - 1000 : OLD,
					state: draw > 0.92 ? 'deleted' : 'active'
				})
			);
		}
		const reported = hosts.filter(() => next() < 0.6);
		const hashedFrame = next() < 0.4;
		return {
			rows,
			frame: {
				names: hashedFrame ? reported.map(fakeToken) : reported,
				hashed: hashedFrame
			} satisfies BoxFrame
		};
	}

	it('is idempotent: applying the answer and asking again changes nothing', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = rng(seed);
			const { rows, frame } = world(next);
			const first = run(rows, frame, { maxCreate: 100 });
			const again = run(apply(rows, first), frame, { maxCreate: 100 });
			expect(again, `seed ${seed}`).toMatchObject({
				create: [],
				learn: [],
				markMissing: [],
				markPresent: []
			});
		}
	});

	it('does not depend on the order of the names or of the rows', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = rng(seed);
			const { rows, frame } = world(next);
			const base = run(rows, frame);
			const mixed = run(shuffle(rows, next), {
				...frame,
				names: shuffle(frame.names, next)
			});
			expect(mixed, `seed ${seed}`).toEqual(base);
		}
	});

	it('creates nothing when the same frame arrives again, however many times', () => {
		for (let seed = 1; seed <= 100; seed++) {
			const next = rng(seed);
			const { rows, frame } = world(next);
			let state = apply(rows, run(rows, frame, { maxCreate: 100 }));
			for (let again = 0; again < 3; again++) {
				const changes = run(state, frame, { maxCreate: 100 });
				expect(changes.create, `seed ${seed}`).toEqual([]);
				state = apply(state, changes);
			}
		}
	});

	it('never invents a host or a name for a hashed frame', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = rng(seed);
			const { rows } = world(next);
			const names = hosts.filter(() => next() < 0.7).map(fakeToken);
			const changes = run(rows, { names, hashed: true }, { maxCreate: 100 });
			for (const found of changes.create) {
				expect(found.host, `seed ${seed}`).toBeNull();
				expect(names).toContain(found.foundAs);
				expect(found.name).toMatch(/^Site \d+ on campus-box$/);
			}
			expect(new Set(changes.create.map((item) => item.name)).size).toBe(
				changes.create.length
			);
		}
	});

	it('gives every created row a name no live row and no other new row holds', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = rng(seed);
			const { rows, frame } = world(next);
			const changes = run(rows, frame, { maxCreate: 100 });
			const held = new Set(
				rows.filter((row) => row.state === 'active').map((row) => row.name)
			);
			const names = changes.create.map((item) => item.name);
			expect(new Set(names).size).toBe(names.length);
			for (const name of names) expect(held.has(name), `seed ${seed}`).toBe(false);
		}
	});

	it('puts every row in exactly one of the groups, and a row that is not live in none', () => {
		for (let seed = 1; seed <= 100; seed++) {
			const next = rng(seed);
			const { rows, frame } = world(next);
			const changes = run(rows, frame);
			const groups = [...changes.markMissing, ...changes.markPresent, ...changes.unchanged];
			expect(new Set(groups).size, `seed ${seed}`).toBe(groups.length);
			const considered = rows.filter(
				(row) => row.state === 'active' || (row.state === 'deleted' && row.foundAs !== null)
			);
			expect([...groups].sort()).toEqual(considered.map((row) => row.id).sort());
		}
	});
});

describe('frameDigest and tokensFor', () => {
	it('holds still under order and repeats, and moves with the set and the hashed flag', async () => {
		const base = await frameDigest(clear('b.example.org', 'a.example.org'));
		expect(await frameDigest(clear('a.example.org', 'B.example.org', 'a.example.org'))).toBe(
			base
		);
		expect(await frameDigest(clear('a.example.org'))).not.toBe(base);
		expect(
			await frameDigest({ names: ['b.example.org', 'a.example.org'], hashed: true })
		).not.toBe(base);
	});

	it('hashes the hosts of the rows and the names of a clear frame, and nothing else', async () => {
		const rows = [
			known({ id: 'site_a', host: 'a.example.org' }),
			known({ id: 'site_b', foundAs: 'b.example.org' }),
			known({ id: 'site_c', foundAs: await boxToken(NODE, 'c.example.org') })
		];
		const tokenOf = await tokensFor(NODE, rows, clear('d.example.org'));
		expect(tokenOf('a.example.org')).toBe(bastionToken(NODE, 'a.example.org'));
		expect(tokenOf('b.example.org')).toBe(bastionToken(NODE, 'b.example.org'));
		expect(tokenOf('d.example.org')).toBe(bastionToken(NODE, 'd.example.org'));
		expect(tokenOf('c.example.org')).toBe('');
		const hashedOnly = await tokensFor(NODE, rows, { names: [], hashed: true });
		expect(hashedOnly('d.example.org')).toBe('');
	});
});
