import type { DnsAnswer, DnsReply, DnsResolver, DnsType } from '../domain/dns-check';

const ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS = 5000;

const NAMES: Record<number, string> = {
	1: 'A',
	5: 'CNAME',
	6: 'SOA',
	16: 'TXT',
	28: 'AAAA',
	257: 'CAA'
};

interface DohBody {
	Status: number;
	Answer?: Array<{ name: string; type: number; data: string }>;
}

// Status 0 is an answer and 3 is a name that does not exist; every other status (a server failure,
// a refusal) and every transport error is `not ok`, so it never reads as a missing record
export function dohResolver(fetchFn: typeof fetch = fetch): DnsResolver {
	return {
		async query(name: string, type: DnsType): Promise<DnsReply> {
			let response: Response;
			try {
				response = await fetchFn(
					`${ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`,
					{
						headers: { accept: 'application/dns-json' },
						signal: AbortSignal.timeout(TIMEOUT_MS)
					}
				);
			} catch {
				return { ok: false };
			}
			if (!response.ok) {
				await response.body?.cancel();
				return { ok: false };
			}
			let body: DohBody;
			try {
				body = (await response.json()) as DohBody;
			} catch {
				return { ok: false };
			}
			if (body.Status === 3) return { ok: true, records: [] };
			if (body.Status !== 0) return { ok: false };
			const records: DnsAnswer[] = (body.Answer ?? []).map((answer) => ({
				name: answer.name,
				type: NAMES[answer.type] ?? String(answer.type),
				data: answer.data
			}));
			return { ok: true, records };
		}
	};
}
