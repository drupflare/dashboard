import { PermanentError } from '../step';

export interface DnsLookup {
	// seconds the answer may still be cached, the smallest across the records; null when there are none
	ttl: number | null;
	// the names a CNAME chain passes through, lowercase and without the final dot
	names: string[];
	addresses: string[];
}

export interface DnsReader {
	lookup(hostname: string): Promise<DnsLookup>;
}

const ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const TYPES = { A: 1, CNAME: 5, AAAA: 28 } as const;

interface DohAnswer {
	Status: number;
	Answer?: Array<{ type: number; TTL: number; data: string }>;
}

const bare = (name: string) => name.replace(/\.$/, '').toLowerCase();

// a resolver answers with the cache time that is left, so the figure can be lower than the zone's own
export function dohReader(fetchFn: typeof fetch = fetch): DnsReader {
	const query = async (hostname: string, type: 'A' | 'AAAA') => {
		let response: Response;
		try {
			response = await fetchFn(
				`${ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
				{
					headers: { accept: 'application/dns-json' }
				}
			);
		} catch {
			throw new Error('the DNS lookup did not answer');
		}
		if (!response.ok) throw new Error(`the DNS lookup answered ${response.status}`);
		const body = (await response.json()) as DohAnswer;
		return body.Status === 0 ? (body.Answer ?? []) : [];
	};
	return {
		async lookup(hostname) {
			const answers = [...(await query(hostname, 'A')), ...(await query(hostname, 'AAAA'))];
			const ttls = answers.map((answer) => answer.TTL).filter((ttl) => Number.isFinite(ttl));
			return {
				ttl: ttls.length === 0 ? null : Math.min(...ttls),
				names: [
					...new Set(
						answers.filter((a) => a.type === TYPES.CNAME).map((a) => bare(a.data))
					)
				],
				addresses: [
					...new Set(
						answers
							.filter((a) => a.type === TYPES.A || a.type === TYPES.AAAA)
							.map((a) => a.data.toLowerCase())
					)
				]
			};
		}
	};
}

// true when the address reaches the target by a CNAME or by sharing an address with it
export async function pointsAt(
	reader: DnsReader,
	hostname: string,
	target: string
): Promise<boolean> {
	const [moving, own] = await Promise.all([reader.lookup(hostname), reader.lookup(target)]);
	if (moving.names.includes(bare(target))) return true;
	return moving.addresses.some((address) => own.addresses.includes(address));
}

export const DNS_UNREADABLE =
	'Drupflare could not read the DNS records of your address. Try again in a moment.';

export function routeNotSeen(to: 'destination' | 'source'): PermanentError {
	return new PermanentError(
		'route_not_seen',
		to === 'destination'
			? 'Your address did not point at the new site in time. Point it at the new site and start the move again.'
			: 'Your address still points at the new site. Point it back at your old site.'
	);
}
