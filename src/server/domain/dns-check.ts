import { CHALLENGE_LABEL, CHALLENGE_PREFIX } from '../../shared/custody/challenge';
import { APEX_ROUTING_NOTE, type DnsRecord } from '../../shared/domain-copy';

// #region resolver port

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'CAA' | 'SOA';

export interface DnsAnswer {
	name: string;
	type: string;
	data: string;
}

// a name with no records is `ok` with an empty list; a resolver that could not answer is not `ok`
export type DnsReply = { ok: true; records: DnsAnswer[] } | { ok: false };

export interface DnsResolver {
	query(name: string, type: DnsType): Promise<DnsReply>;
}

async function ask(resolver: DnsResolver, name: string, type: DnsType): Promise<DnsReply> {
	try {
		return await resolver.query(name, type);
	} catch {
		return { ok: false };
	}
}

const bare = (name: string) => name.replace(/\.$/, '').toLowerCase();

// #endregion

// #region the records the owner adds

export function isLikelyApex(hostname: string): boolean {
	return hostname.split('.').length <= 2;
}

// a name with its own SOA record is the top of a zone, where a CNAME cannot sit beside other records
export async function isApex(resolver: DnsResolver, hostname: string): Promise<boolean> {
	if (isLikelyApex(hostname)) return true;
	const reply = await ask(resolver, hostname, 'SOA');
	return (
		reply.ok && reply.records.some((r) => r.type === 'SOA' && bare(r.name) === bare(hostname))
	);
}

export interface RecordListInput {
	hostname: string;
	apex: boolean;
	// the name visitors are sent to; null while custom domains are off
	target: string | null;
	challenge: string;
}

// A and AAAA records are not offered: no static address list is configured for the target
export function recordList(input: RecordListInput): DnsRecord[] {
	const list: DnsRecord[] = [
		{
			purpose: 'ownership',
			type: 'TXT',
			name: `${CHALLENGE_LABEL}.${input.hostname}`,
			value: input.challenge
		}
	];
	if (input.target !== null) {
		list.push({
			purpose: 'traffic',
			type: 'CNAME',
			name: input.hostname,
			value: input.target,
			...(input.apex ? { note: APEX_ROUTING_NOTE } : {})
		});
	}
	return list;
}

// the base list first, then what the provider added that the base does not already name
export function mergeRecords(base: DnsRecord[], provided: DnsRecord[]): DnsRecord[] {
	const key = (r: DnsRecord) => `${r.purpose}|${r.type}|${r.name}`;
	const held = new Set(base.map(key));
	return [...base, ...provided.filter((r) => !held.has(key(r)))];
}

// #endregion

// #region reading answers

// a TXT answer arrives as one or more quoted strings that the record joins
export function textOf(data: string): string {
	const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
		(m[1] ?? '').replace(/\\(.)/g, '$1')
	);
	return chunks.length === 0 ? data : chunks.join('');
}

export interface CaaEntry {
	tag: string;
	value: string;
}

// resolvers answer a CAA record as text or as raw bytes (RFC 3597); anything else reads as unknown
export function caaOf(data: string): CaaEntry | null {
	const text = /^\s*\d+\s+([A-Za-z0-9]+)\s+"?([^"]*)"?\s*$/.exec(data);
	if (text) return { tag: (text[1] as string).toLowerCase(), value: text[2] as string };
	const raw = /^\\#\s+(\d+)\s*((?:[0-9a-fA-F]{2}\s*)*)$/.exec(data);
	if (!raw) return null;
	const hex = (raw[2] as string).replace(/\s+/g, '');
	if (hex.length !== Number(raw[1]) * 2 || hex.length < 4) return null;
	const bytes = hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16));
	const tagLength = bytes[1] as number;
	if (tagLength === 0 || 2 + tagLength > bytes.length) return null;
	const decode = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
	return {
		tag: decode(2, 2 + tagLength).toLowerCase(),
		value: decode(2 + tagLength, bytes.length)
	};
}

// the certificate authorities Cloudflare's certificate service issues from, by their CAA names
// (Cloudflare docs, "Troubleshooting", certificate validation for Cloudflare for SaaS)
export const ISSUERS = ['letsencrypt.org', 'pki.goog', 'ssl.com'] as const;

// #endregion

// #region the check

export type RecordStatus = 'ok' | 'missing' | 'wrong' | 'unknown';

export interface RecordResult extends DnsRecord {
	status: RecordStatus;
	// what the resolver holds at that name instead, when it is not what the record asks for
	found: string[];
}

export type HazardCode = 'apex_cname' | 'conflicting_records' | 'caa_blocks' | 'second_challenge';

export interface Hazard {
	code: HazardCode;
	// the values the hazard names, such as the addresses found or the issuers a CAA set allows
	found: string[];
}

export interface CheckResult {
	hostname: string;
	apex: boolean;
	records: RecordResult[];
	hazards: Hazard[];
	// true when any record could not be read, which is never read as missing
	unknown: boolean;
}

export interface CheckInput {
	hostname: string;
	apex: boolean;
	records: DnsRecord[];
	// every ownership value that counts, newest first
	accepted: string[];
	target: string | null;
}

const unique = (values: string[]) => [...new Set(values)];

async function txtAt(resolver: DnsResolver, name: string) {
	const reply = await ask(resolver, name, 'TXT');
	if (!reply.ok) return null;
	return reply.records.filter((r) => r.type === 'TXT').map((r) => textOf(r.data));
}

export interface Ownership {
	status: RecordStatus;
	found: string[];
	// every ownership value at the name, which is more than one when an old one was left behind
	challenges: string[];
}

export async function readOwnership(
	resolver: DnsResolver,
	hostname: string,
	accepted: string[]
): Promise<Ownership> {
	const values = await txtAt(resolver, `${CHALLENGE_LABEL}.${hostname}`);
	if (values === null) return { status: 'unknown', found: [], challenges: [] };
	const challenges = values.filter((value) => value.startsWith(CHALLENGE_PREFIX));
	if (challenges.some((value) => accepted.includes(value))) {
		return { status: 'ok', found: [], challenges };
	}
	return { status: challenges.length === 0 ? 'missing' : 'wrong', found: challenges, challenges };
}

export interface Routing {
	status: RecordStatus;
	found: string[];
	direct: { cnames: string[]; addresses: string[] };
}

export async function readRouting(
	resolver: DnsResolver,
	hostname: string,
	target: string
): Promise<Routing> {
	const [cname, a, aaaa, ta, taaaa] = await Promise.all([
		ask(resolver, hostname, 'CNAME'),
		ask(resolver, hostname, 'A'),
		ask(resolver, hostname, 'AAAA'),
		ask(resolver, target, 'A'),
		ask(resolver, target, 'AAAA')
	]);
	const empty = { cnames: [], addresses: [] };
	if (!cname.ok || !a.ok || !aaaa.ok) return { status: 'unknown', found: [], direct: empty };
	const cnames = unique(
		cname.records
			.filter((r) => r.type === 'CNAME' && bare(r.name) === bare(hostname))
			.map((r) => bare(r.data))
	);
	const addressesOf = (replies: DnsReply[], direct: boolean) =>
		unique(
			replies.flatMap((reply) =>
				reply.ok
					? reply.records
							.filter(
								(r) =>
									(r.type === 'A' || r.type === 'AAAA') &&
									(!direct || bare(r.name) === bare(hostname))
							)
							.map((r) => r.data.toLowerCase())
					: []
			)
		);
	const direct = { cnames, addresses: addressesOf([a, aaaa], true) };
	if (cnames.includes(bare(target))) return { status: 'ok', found: [], direct };
	// a flattened or chained record shows as addresses, so sharing one with the target counts
	const reached = addressesOf([a, aaaa], false);
	const mine = addressesOf([ta, taaaa], false);
	if (reached.some((address) => mine.includes(address))) {
		return { status: 'ok', found: [], direct };
	}
	const found = [...cnames, ...direct.addresses];
	return { status: found.length === 0 ? 'missing' : 'wrong', found, direct };
}

// CAA is read from the hostname up, and the first name that has any records decides
async function caaHazard(resolver: DnsResolver, hostname: string): Promise<Hazard | null> {
	const labels = hostname.split('.');
	for (let i = 0; i < labels.length - 1 && i < 6; i++) {
		const reply = await ask(resolver, labels.slice(i).join('.'), 'CAA');
		if (!reply.ok) return null;
		const entries = reply.records.filter((r) => r.type === 'CAA').map((r) => caaOf(r.data));
		if (entries.length === 0) continue;
		if (entries.some((entry) => entry === null)) return null;
		const issuers = (entries as CaaEntry[])
			.filter((entry) => entry.tag === 'issue')
			.map((entry) => (entry.value.split(';')[0] ?? '').trim().toLowerCase());
		if (issuers.length === 0) return null;
		const allowed = issuers.some((issuer) => (ISSUERS as readonly string[]).includes(issuer));
		return allowed ? null : { code: 'caa_blocks', found: unique(issuers) };
	}
	return null;
}

export async function checkRecords(resolver: DnsResolver, input: CheckInput): Promise<CheckResult> {
	const { hostname, apex } = input;
	const hazards: Hazard[] = [];
	let direct: Routing['direct'] | null = null;
	const records = await Promise.all(
		input.records.map(async (record): Promise<RecordResult> => {
			if (record.purpose === 'ownership') {
				const owned = await readOwnership(resolver, hostname, input.accepted);
				if (owned.challenges.length > 1) {
					hazards.push({ code: 'second_challenge', found: owned.challenges });
				}
				return { ...record, status: owned.status, found: owned.found };
			}
			if (record.type === 'TXT') {
				const values = await txtAt(resolver, record.name);
				if (values === null) return { ...record, status: 'unknown', found: [] };
				if (values.includes(record.value)) return { ...record, status: 'ok', found: [] };
				return {
					...record,
					status: values.length === 0 ? 'missing' : 'wrong',
					found: values
				};
			}
			if (input.target === null || record.value !== input.target) {
				return { ...record, status: 'unknown', found: [] };
			}
			const result = await readRouting(resolver, hostname, input.target);
			direct = result.direct;
			return { ...record, status: result.status, found: result.found };
		})
	);
	if (direct !== null) {
		const seen = direct as Routing['direct'];
		const routed = records.find((r) => r.purpose === 'traffic');
		if (apex && seen.cnames.length > 0)
			hazards.push({ code: 'apex_cname', found: seen.cnames });
		if (routed?.status === 'wrong') {
			hazards.push({ code: 'conflicting_records', found: routed.found });
		}
	}
	const caa = await caaHazard(resolver, hostname);
	if (caa !== null) hazards.push(caa);
	return {
		hostname,
		apex,
		records,
		hazards,
		unknown: records.some((record) => record.status === 'unknown')
	};
}

// #endregion
