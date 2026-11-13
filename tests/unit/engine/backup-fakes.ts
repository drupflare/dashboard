import { sha256Hex } from '@contracts/common';
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
	offloaded: number;
	// the paged restore routes exist on this site
	paged: boolean;
	upload: FakeUpload | null;
	// commit calls that answer not done before the upload completes
	commitsBeforeDone: number;
	// export pages end on a statement, as the site's own pages do
	aligned: boolean;
	// part numbers answered 422 for a digest that does not match
	digestRefusals: Set<number>;
	// when set, every commit call reports this many parts assembled
	stuckAssembled: number | null;
	// part number to the count of 503 answers before it is accepted
	putFailures: Map<number, number>;
	// the files only R2 holds; null means the site has no list route
	files: FakeFile[] | null;
	// uri to the count of 502 answers before the file streams
	fileFailures: Map<string, number>;
	// uris whose stream carries other bytes than the list digest names
	fileCorrupt: Set<string>;
}

export interface FakeFile {
	uri: string;
	bytes: Uint8Array;
	contentType?: string | null;
	modified?: number;
}

interface FakeUpload {
	id: string;
	label: string;
	bytes: number;
	parts: number;
	sha256: string;
	received: Map<number, Uint8Array>;
	commits: number;
}

export function fakeWorkers(log: string[], ceiling = 16 * MIB) {
	const sites = new Map<string, FakeSite>();
	const calls = {
		exports: 0,
		restores: [] as { host: string; label: string; body: string }[],
		begins: [] as {
			host: string;
			label: string;
			bytes: number;
			parts: number;
			sha256: string;
		}[],
		puts: [] as { host: string; part: number; bytes: number }[],
		commits: 0,
		aborts: 0,
		listings: [] as { after: string | null; limit: number }[],
		fetched: [] as string[]
	};
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
			offloaded: 0,
			paged: true,
			aligned: false,
			digestRefusals: new Set(),
			stuckAssembled: null,
			upload: null,
			commitsBeforeDone: 0,
			putFailures: new Map(),
			files: null,
			fileFailures: new Map(),
			fileCorrupt: new Set(),
			...patch
		};
		sites.set(host, site);
		return site;
	};
	const pageCache = new WeakMap<FakeSite, string[]>();
	const alignedPages = (site: FakeSite) => {
		let pages = pageCache.get(site);
		if (pages === undefined) {
			pages = [];
			let at = 0;
			while (at < site.sql.length) {
				let end = Math.min(site.sql.length, at + site.pageChars);
				if (end < site.sql.length) {
					const next = site.sql.indexOf(';\n', end);
					end = next === -1 ? site.sql.length : next + 2;
				}
				pages.push(site.sql.slice(at, end));
				at = end;
			}
			pageCache.set(site, pages);
		}
		return pages;
	};
	const reply = (status: number, code: string, extra: object = {}) =>
		Response.json({ ok: false, error: code, code, ...extra }, { status });
	const uploadView = (site: FakeSite) => {
		const up = site.upload;
		return up === null
			? { ok: true, upload: null }
			: {
					ok: true,
					upload: up.id,
					label: up.label,
					receivedParts: [...up.received.keys()].sort((a, b) => a - b)
				};
	};
	const restoreParts = async (url: URL, site: FakeSite, init?: RequestInit) => {
		if (!site.paged) return new Response('not here', { status: 404 });
		const action = url.searchParams.get('action');
		if (action === 'status') {
			const wanted = url.searchParams.get('upload');
			if (wanted !== null && site.upload?.id !== wanted) return reply(404, 'unknown_upload');
			return Response.json(uploadView(site));
		}
		if (action === 'begin') {
			const declared = JSON.parse(String(init?.body)) as {
				bytes: number;
				parts: number;
				sha256: string;
				label: string;
			};
			calls.begins.push({ host: '', ...declared });
			const open = site.upload;
			if (
				open !== null &&
				(open.sha256 !== declared.sha256 || open.parts !== declared.parts)
			) {
				return reply(409, 'busy', { upload: open.id });
			}
			if (open === null) {
				site.upload = {
					id: `up_${calls.begins.length}`,
					...declared,
					received: new Map(),
					commits: 0
				};
			}
			return Response.json({ ...uploadView(site), created: open === null });
		}
		const up = site.upload;
		if (up === null || url.searchParams.get('upload') !== up.id) {
			return reply(404, 'unknown_upload');
		}
		if (action === 'put') {
			const part = Number(url.searchParams.get('part'));
			const body = new Uint8Array(init?.body as Uint8Array);
			const left = site.putFailures.get(part) ?? 0;
			if (left > 0) {
				site.putFailures.set(part, left - 1);
				return new Response('try later', { status: 503 });
			}
			if (body.byteLength > MIB) return reply(413, 'too_large', { limit: MIB });
			const header = new Headers(init?.headers).get('x-part-sha256');
			if (site.digestRefusals.has(part) || (await sha256Hex(body)) !== header) {
				return reply(422, 'digest', { part });
			}
			const stored = !up.received.has(part);
			up.received.set(part, body);
			calls.puts.push({ host: '', part, bytes: body.byteLength });
			return Response.json({ part, stored, ...uploadView(site) });
		}
		if (action === 'commit') {
			calls.commits++;
			up.commits++;
			if (up.received.size < up.parts) {
				return reply(409, 'incomplete', { missing: [] });
			}
			if (up.commits <= site.commitsBeforeDone) {
				return Response.json({
					ok: true,
					done: false,
					assembledParts: site.stuckAssembled ?? up.commits,
					parts: up.parts
				});
			}
			const joined = new Uint8Array(up.bytes);
			let at = 0;
			for (let n = 0; n < up.parts; n++) {
				const bytes = up.received.get(n)!;
				joined.set(bytes, at);
				at += bytes.byteLength;
			}
			if (at !== up.bytes || (await sha256Hex(joined)) !== up.sha256) {
				return reply(422, 'whole_digest');
			}
			const body = new TextDecoder().decode(joined);
			site.imports.push({ label: up.label, body, state: 'pending', ticks: 0 });
			log.push(`restore:${site.siteId}`);
			site.upload = null;
			return Response.json({ ok: true, done: true, id: 1, chunks: 1, statements: 1 });
		}
		if (action === 'abort') {
			calls.aborts++;
			site.upload = null;
			return Response.json({ ok: true, aborted: true });
		}
		return reply(400, 'bad_request');
	};
	const offloadedRoute = async (url: URL, site: FakeSite) => {
		if (site.files === null) return new Response('not here', { status: 404 });
		const uri = url.searchParams.get('uri');
		if (uri !== null) {
			const file = site.files.find((candidate) => candidate.uri === uri);
			if (file === undefined) return reply(404, 'not_found');
			calls.fetched.push(uri);
			const left = site.fileFailures.get(uri) ?? 0;
			if (left > 0) {
				site.fileFailures.set(uri, left - 1);
				return reply(502, 'storage_unavailable');
			}
			const sha = await sha256Hex(file.bytes);
			const bytes = site.fileCorrupt.has(uri)
				? file.bytes.map((byte) => byte ^ 1)
				: file.bytes;
			return new Response(bytes as Uint8Array<ArrayBuffer>, {
				status: 200,
				headers: {
					'x-cfw-file-size': String(file.bytes.byteLength),
					'x-cfw-file-sha256': sha,
					'content-length': String(bytes.byteLength)
				}
			});
		}
		const after = url.searchParams.get('after');
		const limit = Number(url.searchParams.get('limit') ?? 500);
		calls.listings.push({ after, limit });
		const sorted = [...site.files].sort((a, b) => (a.uri < b.uri ? -1 : 1));
		const rest = sorted.filter((file) => after === null || file.uri > after);
		const page = rest.slice(0, limit);
		const files = await Promise.all(
			page.map(async (file) => ({
				uri: file.uri,
				scheme: file.uri.split(':')[0],
				path: file.uri.split('//')[1],
				size: file.bytes.byteLength,
				contentType: file.contentType ?? null,
				sha256: await sha256Hex(file.bytes),
				modified: file.modified ?? 1_700_000_000_000
			}))
		);
		return Response.json({
			ok: true,
			files,
			next: rest.length > limit ? page.at(-1)!.uri : null,
			...(after === null
				? {
						total: {
							files: site.files.length,
							bytes: site.files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
						}
					}
				: {})
		});
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
			let sql: string;
			let more: boolean;
			if (site.aligned) {
				const pages = alignedPages(site);
				sql = pages[page] ?? '';
				more = page + 1 < pages.length;
			} else {
				const from = page * site.pageChars;
				sql = site.sql.slice(from, from + site.pageChars);
				more = from + site.pageChars < site.sql.length;
			}
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
		if (url.pathname === '/restore-parts') return restoreParts(url, site, init);
		if (url.pathname === '/offloaded') return offloadedRoute(url, site);
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
			return Response.json({
				storage: {
					files: 0,
					offloaded: { files: site.offloaded, bytes: 0 },
					adopting: site.adopting
				}
			});
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

// the worker's quote-aware splitter, which reads each part at the other end
export function splitLikeTheWorker(dump: string): { statements: string[]; tail: string } {
	const out: string[] = [];
	let current = '';
	let single = false;
	let double = false;
	for (let i = 0; i < dump.length; i++) {
		const ch = dump[i] as string;
		if (single) {
			current += ch;
			if (ch === "'") {
				if (dump[i + 1] === "'") {
					current += "'";
					i++;
				} else single = false;
			}
			continue;
		}
		if (double) {
			current += ch;
			if (ch === '"') {
				if (dump[i + 1] === '"') {
					current += '"';
					i++;
				} else double = false;
			}
			continue;
		}
		if (ch === "'") {
			single = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			double = true;
			current += ch;
			continue;
		}
		if (ch === '-' && dump[i + 1] === '-') {
			const nl = dump.indexOf('\n', i);
			i = nl === -1 ? dump.length : nl;
			continue;
		}
		if (ch === ';') {
			if (current.trim().length > 0) out.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	return { statements: out, tail: current.trim() };
}
