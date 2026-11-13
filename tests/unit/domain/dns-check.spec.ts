import { describe, expect, it } from 'vitest';
import {
	caaOf,
	checkRecords,
	isApex,
	isLikelyApex,
	mergeRecords,
	readOwnership,
	readRouting,
	recordList,
	textOf,
	type DnsResolver
} from '../../../src/server/domain/dns-check';
import { dohResolver } from '../../../src/server/integrations/dns-resolver';
import { APEX_ROUTING_NOTE, hazardText, type DnsRecord } from '../../../src/shared/domain-copy';
import { fakeDns, type FakeDns } from './dns-fakes';

const HOST = 'www.example.edu';
const TARGET = 'edge.example.net';
const MINE = 'drupflare-verify=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'drupflare-verify=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = 'drupflare-verify=cccccccccccccccccccccccccccccccc';

const world = fakeDns;

const challenge = (name = HOST) => `_drupflare-challenge.${name}`;
const owner = (name = HOST) => ({
	purpose: 'ownership' as const,
	type: 'TXT' as const,
	name: challenge(name),
	value: MINE
});
const route = (name = HOST) => ({
	purpose: 'traffic' as const,
	type: 'CNAME' as const,
	name,
	value: TARGET
});

async function check(
	w: FakeDns,
	over: { hostname?: string; apex?: boolean; records?: DnsRecord[] } = {}
) {
	const hostname = over.hostname ?? HOST;
	return checkRecords(w.resolver, {
		hostname,
		apex: over.apex ?? false,
		records: over.records ?? [owner(hostname), route(hostname)],
		accepted: [MINE, OLD],
		target: TARGET
	});
}

describe('the records the owner adds', () => {
	it('lists the ownership record and then the routing record for a subdomain', () => {
		const list = recordList({ hostname: HOST, apex: false, target: TARGET, challenge: MINE });
		expect(list).toEqual([owner(), route()]);
		expect(list[1]).not.toHaveProperty('note');
	});

	it('adds plain words about aliases to the routing record of a bare domain', () => {
		const list = recordList({
			hostname: 'example.edu',
			apex: true,
			target: TARGET,
			challenge: MINE
		});
		expect(list[1]).toMatchObject({ type: 'CNAME', note: APEX_ROUTING_NOTE });
		expect(APEX_ROUTING_NOTE).toMatch(/www/);
		expect(APEX_ROUTING_NOTE).toMatch(/ALIAS, ANAME or flattened CNAME/);
	});

	it('offers no A or AAAA record, and no routing record while custom domains are off', () => {
		const list = recordList({ hostname: HOST, apex: false, target: null, challenge: MINE });
		expect(list).toEqual([owner()]);
		const full = recordList({ hostname: HOST, apex: false, target: TARGET, challenge: MINE });
		expect(full.map((record) => record.type)).toEqual(['TXT', 'CNAME']);
	});

	it('merges what the provider adds without repeating a record it already names', () => {
		const base = [owner(), route()];
		const provided = [
			{
				purpose: 'certificate' as const,
				type: 'TXT' as const,
				name: '_acme-challenge.x',
				value: 'c'
			},
			{ ...route(), value: 'other.example.net' }
		];
		expect(mergeRecords(base, provided)).toEqual([...base, provided[0]]);
	});

	it('treats two labels as a bare domain and asks the zone about longer names', async () => {
		expect(isLikelyApex('example.edu')).toBe(true);
		expect(isLikelyApex(HOST)).toBe(false);
		const w = world();
		expect(await isApex(w.resolver, 'example.edu')).toBe(true);
		expect(w.asked).toEqual([]);
		expect(await isApex(w.resolver, 'a.example.co.uk')).toBe(false);
		w.put('SOA', 'a.example.co.uk', 'ns.example.co.uk hostmaster.example.co.uk 1 2 3 4 5');
		expect(await isApex(w.resolver, 'a.example.co.uk')).toBe(true);
		w.fail('SOA', 'b.example.co.uk');
		expect(await isApex(w.resolver, 'b.example.co.uk')).toBe(false);
	});
});

describe('reading answers', () => {
	it('joins the quoted strings of a text record and keeps escapes', () => {
		expect(textOf('"drupflare-verify=abc"')).toBe('drupflare-verify=abc');
		expect(textOf('"abc" "def"')).toBe('abcdef');
		expect(textOf('"a\\"b"')).toBe('a"b');
		expect(textOf('bare')).toBe('bare');
	});

	it('reads a CAA record as text or as raw bytes and drops anything else', () => {
		expect(caaOf('0 issue "letsencrypt.org"')).toEqual({
			tag: 'issue',
			value: 'letsencrypt.org'
		});
		expect(caaOf('128 issuewild ";"')).toEqual({ tag: 'issuewild', value: ';' });
		// flags 0, tag "issue", value "ssl.com"
		expect(caaOf('\\# 14 0005697373756573736c2e636f6d')).toEqual({
			tag: 'issue',
			value: 'ssl.com'
		});
		expect(caaOf('\\# 4 zz')).toBeNull();
		expect(caaOf('\\# 3 000000')).toBeNull();
		expect(caaOf('\\# 2 0000')).toBeNull();
		expect(caaOf('not a record')).toBeNull();
	});
});

describe('checking the ownership record', () => {
	it('finds the value, an older value of the key ring, and nothing', async () => {
		const w = world();
		w.put('TXT', challenge(), `"${MINE}"`);
		expect(await readOwnership(w.resolver, HOST, [MINE, OLD])).toMatchObject({ status: 'ok' });
		w.put('TXT', challenge(), `"${OLD}"`);
		expect(await readOwnership(w.resolver, HOST, [MINE, OLD])).toMatchObject({ status: 'ok' });
		w.put('TXT', challenge());
		expect(await readOwnership(w.resolver, HOST, [MINE])).toEqual({
			status: 'missing',
			found: [],
			challenges: []
		});
	});

	it('names what it found when the value is another one, and ignores unrelated text', async () => {
		const w = world();
		w.put('TXT', challenge(), `"${OTHER}"`, '"v=spf1 -all"');
		const result = await readOwnership(w.resolver, HOST, [MINE]);
		expect(result).toMatchObject({ status: 'wrong', found: [OTHER], challenges: [OTHER] });
		w.put('TXT', challenge(), '"v=spf1 -all"');
		expect((await readOwnership(w.resolver, HOST, [MINE])).status).toBe('missing');
	});

	it('reads a resolver that fails as unknown and never as missing', async () => {
		const w = world();
		w.fail('TXT', challenge());
		expect(await readOwnership(w.resolver, HOST, [MINE])).toMatchObject({ status: 'unknown' });
		const throwing: DnsResolver = {
			query: async () => {
				throw new Error('socket closed');
			}
		};
		const result = await checkRecords(throwing, {
			hostname: HOST,
			apex: false,
			records: [owner(), route()],
			accepted: [MINE],
			target: TARGET
		});
		expect(result.records.map((record) => record.status)).toEqual(['unknown', 'unknown']);
		expect(result.unknown).toBe(true);
		expect(result.hazards).toEqual([]);
	});
});

describe('checking the routing record', () => {
	it('is ok for a CNAME to the target', async () => {
		const w = world();
		w.put('CNAME', HOST, `${TARGET}.`);
		expect((await readRouting(w.resolver, HOST, TARGET)).status).toBe('ok');
	});

	it('is ok for a flattened record or a chain that reaches the target address', async () => {
		const w = world();
		w.put('A', TARGET, '192.0.2.10');
		w.put('A', HOST, '192.0.2.10');
		expect((await readRouting(w.resolver, HOST, TARGET)).status).toBe('ok');
		const chained = world();
		chained.put('AAAA', TARGET, '2001:db8::1');
		chained.put('CNAME', HOST, 'middle.example.edu');
		chained.raw('AAAA', HOST, [
			{ name: 'middle.example.edu', type: 'AAAA', data: '2001:DB8::1' }
		]);
		expect((await readRouting(chained.resolver, HOST, TARGET)).status).toBe('ok');
	});

	it('is missing with no records and wrong, with what was found, when they point elsewhere', async () => {
		const w = world();
		expect(await readRouting(w.resolver, HOST, TARGET)).toMatchObject({
			status: 'missing',
			found: []
		});
		w.put('CNAME', HOST, 'old.example.org.');
		w.put('A', HOST, '198.51.100.7');
		w.put('A', TARGET, '192.0.2.10');
		const result = await readRouting(w.resolver, HOST, TARGET);
		expect(result.status).toBe('wrong');
		expect(result.found).toEqual(['old.example.org', '198.51.100.7']);
	});

	it('is unknown when any lookup fails', async () => {
		for (const type of ['CNAME', 'A', 'AAAA'] as const) {
			const w = world();
			w.fail(type, HOST);
			expect((await readRouting(w.resolver, HOST, TARGET)).status).toBe('unknown');
		}
	});
});

describe('checking every record together', () => {
	it('reports each record on its own evidence', async () => {
		const w = world();
		w.put('TXT', challenge(), `"${MINE}"`);
		const result = await check(w);
		expect(result.records.map((record) => [record.purpose, record.status])).toEqual([
			['ownership', 'ok'],
			['traffic', 'missing']
		]);
		expect(result.unknown).toBe(false);
		expect(result.hazards).toEqual([]);
	});

	it('checks a certificate text record by its exact value', async () => {
		const w = world();
		const certificate = {
			purpose: 'certificate' as const,
			type: 'TXT' as const,
			name: `_acme-challenge.${HOST}`,
			value: 'token-1'
		};
		w.put('TXT', certificate.name, '"token-1"');
		expect((await check(w, { records: [certificate] })).records[0]?.status).toBe('ok');
		w.put('TXT', certificate.name, '"token-0"');
		const stale = (await check(w, { records: [certificate] })).records[0];
		expect(stale).toMatchObject({ status: 'wrong', found: ['token-0'] });
		w.put('TXT', certificate.name);
		expect((await check(w, { records: [certificate] })).records[0]?.status).toBe('missing');
		w.fail('TXT', certificate.name);
		expect((await check(w, { records: [certificate] })).records[0]?.status).toBe('unknown');
	});

	it('says a record cannot be checked when the routing target is unknown', async () => {
		const w = world();
		const result = await checkRecords(w.resolver, {
			hostname: HOST,
			apex: false,
			records: [route()],
			accepted: [],
			target: null
		});
		expect(result.records[0]?.status).toBe('unknown');
	});

	it('warns about a second ownership value even when one is right', async () => {
		const w = world();
		w.put('TXT', challenge(), `"${MINE}"`, `"${OTHER}"`);
		const result = await check(w);
		expect(result.records[0]?.status).toBe('ok');
		expect(result.hazards).toEqual([{ code: 'second_challenge', found: [MINE, OTHER] }]);
	});

	it('names the records that point the name somewhere else', async () => {
		const w = world();
		w.put('A', HOST, '198.51.100.7');
		w.put('A', TARGET, '192.0.2.10');
		const result = await check(w);
		expect(result.hazards).toEqual([{ code: 'conflicting_records', found: ['198.51.100.7'] }]);
		expect(hazardText('conflicting_records', ['198.51.100.7'])).toContain('198.51.100.7');
	});

	it('warns about an alias record on a bare domain', async () => {
		const w = world();
		w.put('CNAME', 'example.edu', 'old.example.org');
		const result = await check(w, {
			hostname: 'example.edu',
			apex: true,
			records: [owner('example.edu'), route('example.edu')]
		});
		expect(result.hazards.map((hazard) => hazard.code)).toEqual([
			'apex_cname',
			'conflicting_records'
		]);
		expect(result.apex).toBe(true);
	});

	it('does not warn about an alias on a bare domain for a subdomain', async () => {
		const w = world();
		w.put('CNAME', HOST, 'old.example.org');
		expect((await check(w)).hazards.map((hazard) => hazard.code)).toEqual([
			'conflicting_records'
		]);
	});
});

describe('CAA records that block the certificate', () => {
	const blocks = async (w: FakeDns) =>
		(await check(w)).hazards.filter((hazard) => hazard.code === 'caa_blocks');

	it('warns when a set names no issuer the certificate service uses', async () => {
		const w = world();
		w.put('CAA', HOST, '0 issue "amazon.com"', '0 issue "digicert.com"');
		expect(await blocks(w)).toEqual([
			{ code: 'caa_blocks', found: ['amazon.com', 'digicert.com'] }
		]);
		expect(hazardText('caa_blocks', ['amazon.com'])).toMatch(
			/letsencrypt.org, pki.goog and ssl.com/
		);
	});

	it.each(['letsencrypt.org', 'pki.goog; cansignhttpexchanges=yes', 'ssl.com'])(
		'does not warn when the set allows %s',
		async (issuer) => {
			const w = world();
			w.put('CAA', HOST, '0 issue "amazon.com"', `0 issue "${issuer}"`);
			expect(await blocks(w)).toEqual([]);
		}
	);

	it('reads the nearest name that has any records, so a parent decides when the host has none', async () => {
		const w = world();
		w.put('CAA', 'example.edu', '0 issue "amazon.com"');
		expect(await blocks(w)).toHaveLength(1);
		w.put('CAA', HOST, '0 issue "pki.goog"');
		expect(await blocks(w)).toEqual([]);
	});

	it('reads a record that arrives as raw bytes', async () => {
		const w = world();
		// flags 0, tag "issue", value "ca.example"
		w.put('CAA', HOST, '\\# 17 0005697373756563612e6578616d706c65');
		expect(await blocks(w)).toEqual([{ code: 'caa_blocks', found: ['ca.example'] }]);
	});

	it('says nothing for an empty set, one with no issue record, or one it cannot read', async () => {
		const w = world();
		expect(await blocks(w)).toEqual([]);
		w.put('CAA', HOST, '0 iodef "mailto:security@example.edu"');
		expect(await blocks(w)).toEqual([]);
		w.put('CAA', HOST, 'something odd');
		expect(await blocks(w)).toEqual([]);
	});

	it('says nothing when the resolver fails, never reading it as a block', async () => {
		const w = world();
		w.fail('CAA', HOST);
		expect(await blocks(w)).toEqual([]);
	});

	it('treats an issue record that forbids everyone as a block', async () => {
		const w = world();
		w.put('CAA', HOST, '0 issue ";"');
		expect(await blocks(w)).toEqual([{ code: 'caa_blocks', found: [''] }]);
	});
});

describe('the DNS over HTTPS resolver', () => {
	const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	it('maps answers by type name and asks for the name and type', async () => {
		const urls: string[] = [];
		const resolver = dohResolver((async (input: string | URL | Request) => {
			urls.push(String(input));
			return reply({
				Status: 0,
				Answer: [
					{ name: 'a.example.edu.', type: 16, data: '"x"' },
					{ name: 'a.example.edu.', type: 257, data: '0 issue "pki.goog"' },
					{ name: 'a.example.edu.', type: 99, data: 'odd' }
				]
			});
		}) as typeof fetch);
		const answer = await resolver.query('a.example.edu', 'TXT');
		expect(urls[0]).toBe('https://cloudflare-dns.com/dns-query?name=a.example.edu&type=TXT');
		expect(answer).toEqual({
			ok: true,
			records: [
				{ name: 'a.example.edu.', type: 'TXT', data: '"x"' },
				{ name: 'a.example.edu.', type: 'CAA', data: '0 issue "pki.goog"' },
				{ name: 'a.example.edu.', type: '99', data: 'odd' }
			]
		});
	});

	it('reads no records and a name that does not exist as empty answers', async () => {
		const none = dohResolver((async () => reply({ Status: 0 })) as typeof fetch);
		expect(await none.query('a.example.edu', 'A')).toEqual({ ok: true, records: [] });
		const gone = dohResolver((async () => reply({ Status: 3 })) as typeof fetch);
		expect(await gone.query('a.example.edu', 'A')).toEqual({ ok: true, records: [] });
	});

	it('reads a server failure, a bad status, bad JSON and a dead connection as not ok', async () => {
		const failing = [
			dohResolver((async () => reply({ Status: 2 })) as typeof fetch),
			dohResolver((async () => reply({}, 503)) as typeof fetch),
			dohResolver((async () => new Response('<html>', { status: 200 })) as typeof fetch),
			dohResolver((async () => {
				throw new Error('offline');
			}) as typeof fetch)
		];
		for (const resolver of failing) {
			expect(await resolver.query('a.example.edu', 'A')).toEqual({ ok: false });
		}
	});
});
