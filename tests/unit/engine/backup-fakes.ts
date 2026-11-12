import type { BackupBlobs, NamespaceKv } from '../../../engine/src/ports';
import { FAKE_OWNER_TOKEN } from './fakes';

export const MARKER = 'ROWDATA-7f3c91';
export const MIB = 1024 * 1024;

export const dumpOf = (rows: number) =>
	Array.from({ length: rows }, (_, n) => `INSERT INTO t VALUES (${n}, '${MARKER}-${n}');\n`).join(
		''
	);

// #region a fake worker that speaks the owner routes over fetch

interface FakeSite {
	siteId: string;
	token: string;
	sql: string;
	pageChars: number;
	badPage: number | null;
	stall: boolean;
	garbage: boolean;
	imports: {
		label: string;
		body: string;
		state: 'pending' | 'applied' | 'failed';
		ticks: number;
	}[];
	applyAfter: number;
	failImport: boolean;
	adopting: number;
	adoptOnApply: number;
}

export function fakeWorkers(log: string[], ceiling = 16 * MIB) {
	const sites = new Map<string, FakeSite>();
	const calls = { exports: 0, restores: [] as { host: string; label: string; body: string }[] };
	const bearers = new Set<string>();
	let authFailures = 0;
	const add = (host: string, siteId: string, patch: Partial<FakeSite> = {}) => {
		const site: FakeSite = {
			siteId,
			token: FAKE_OWNER_TOKEN,
			sql: '',
			pageChars: 600,
			badPage: null,
			stall: false,
			garbage: false,
			imports: [],
			applyAfter: 2,
			failImport: false,
			adopting: 0,
			adoptOnApply: 0,
			...patch
		};
		sites.set(host, site);
		return site;
	};
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const site = sites.get(url.host);
		if (site === undefined) return new Response('no such site', { status: 404 });
		const header = new Headers(init?.headers).get('authorization') ?? '';
		if (header !== `Bearer ${site.token}`) {
			authFailures++;
			return new Response('no', { status: 401 });
		}
		bearers.add(header);
		if (url.pathname === '/export') {
			calls.exports++;
			const cursor = url.searchParams.get('cursor') ?? '';
			if (site.garbage) return new Response('not json at all', { status: 200 });
			const page = cursor === 'start' ? 0 : Number(cursor.replace('p', ''));
			if (site.badPage === page) return Response.json({ ok: false }, { status: 409 });
			const from = page * site.pageChars;
			const sql = site.sql.slice(from, from + site.pageChars);
			const more = from + site.pageChars < site.sql.length;
			const next = site.stall ? cursor : more ? `p${page + 1}` : null;
			return Response.json({ ok: true, sql, nextCursor: next, replayable: true });
		}
		if (url.pathname === '/restore') {
			const body = String(
				init?.body === undefined ? '' : new TextDecoder().decode(init.body as Uint8Array)
			);
			if (body.length > ceiling) return new Response('too large', { status: 413 });
			const label = url.searchParams.get('label') ?? '';
			calls.restores.push({ host: url.host, label, body });
			log.push(`restore:${site.siteId}`);
			site.imports.push({ label, body, state: 'pending', ticks: 0 });
			return Response.json({ ok: true, id: 1, chunks: 1, statements: 1, generation: label });
		}
		if (url.pathname === '/health') {
			const last = site.imports.at(-1);
			return Response.json({
				tree: {},
				import:
					last === undefined
						? null
						: {
								generation: last.label,
								state: last.state,
								chunk: last.state === 'failed' ? 3 : last.ticks,
								chunks: 9,
								error:
									last.state === 'failed'
										? 'UNIQUE constraint failed: users.uid'
										: null
							}
			});
		}
		if (url.pathname === '/serve-stats') {
			log.push(`adopting:${site.siteId}:${site.adopting}`);
			return Response.json({ storage: { files: 0, adopting: site.adopting } });
		}
		return new Response('unknown', { status: 404 });
	};
	// one alarm: pending imports advance, and file copies finish one at a time after an import landed
	const alarm = () => {
		for (const site of sites.values()) {
			for (const item of site.imports) {
				if (item.state !== 'pending') continue;
				item.ticks++;
				if (item.ticks >= site.applyAfter) {
					item.state = site.failImport ? 'failed' : 'applied';
					if (item.state === 'applied') {
						site.sql = item.body;
						site.adopting = site.adoptOnApply;
					}
				}
			}
			if (site.adopting > 0 && site.imports.some((item) => item.state === 'applied')) {
				site.adopting--;
			}
		}
	};
	return {
		sites,
		calls,
		bearers,
		add,
		fetcher: fetcher as typeof fetch,
		alarm,
		authFailures: () => authFailures
	};
}

// #endregion

// #region the world

export function fakeBlobs() {
	const objects = new Map<string, Uint8Array>();
	const blobs: BackupBlobs = {
		async put(key, bytes) {
			objects.set(key, new Uint8Array(bytes));
		},
		async get(key) {
			const found = objects.get(key);
			return found === undefined ? null : new Uint8Array(found);
		},
		async deletePrefix(prefix) {
			let removed = 0;
			for (const key of [...objects.keys()]) {
				if (key.startsWith(prefix)) {
					objects.delete(key);
					removed++;
				}
			}
			return removed;
		}
	};
	return { blobs, objects };
}

export function fakeKv(log: string[]) {
	const spaces = new Map<string, Map<string, string>>();
	const puts: { namespaceId: string; key: string; value: string }[] = [];
	const deletes: { namespaceId: string; key: string }[] = [];
	const kv: NamespaceKv = {
		async put(namespaceId, key, value) {
			puts.push({ namespaceId, key, value });
			log.push(`kv:put:${key}`);
			if (!spaces.has(namespaceId)) spaces.set(namespaceId, new Map());
			spaces.get(namespaceId)!.set(key, value);
		},
		async delete(namespaceId, key) {
			deletes.push({ namespaceId, key });
			log.push(`kv:delete:${key}`);
			return spaces.get(namespaceId)?.delete(key) ? 'deleted' : 'absent';
		}
	};
	return { kv, spaces, puts, deletes };
}
