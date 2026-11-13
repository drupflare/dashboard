import type {
	DnsAnswer,
	DnsReply,
	DnsResolver,
	DnsType
} from '../../../src/server/domain/dns-check';

export type FakeDns = ReturnType<typeof fakeDns>;

// answers by type and name; a missing key is a name with no records and `null` is a resolver that failed
export function fakeDns() {
	const table = new Map<string, DnsAnswer[] | null>();
	const asked: string[] = [];
	let down = false;
	const key = (type: DnsType, name: string) => `${type}|${name}`;
	const resolver: DnsResolver = {
		async query(name, type): Promise<DnsReply> {
			asked.push(key(type, name));
			if (down) return { ok: false };
			const held = table.get(key(type, name));
			return held === null ? { ok: false } : { ok: true, records: held ?? [] };
		}
	};
	return {
		resolver,
		asked,
		put(type: DnsType, name: string, ...data: string[]) {
			table.set(
				key(type, name),
				data.map((entry) => ({ name, type, data: entry }))
			);
		},
		raw(type: DnsType, name: string, records: DnsAnswer[]) {
			table.set(key(type, name), records);
		},
		fail(type: DnsType, name: string) {
			table.set(key(type, name), null);
		},
		// every lookup fails until it is switched back
		outage(on: boolean) {
			down = on;
		},
		clear() {
			table.clear();
		}
	};
}
