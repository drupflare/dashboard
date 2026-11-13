import { utf8 } from '@contracts/common';
import { DEFAULT_RESTORE_CEILING_BYTES, joinParts, restorable } from '../backup-parts';
import type { Custody } from '../custody';
import { PART_BYTES, partKey } from '../import-parts';
import type {
	BackupBlobs,
	BackupLedger,
	BackupWorker,
	ChangeManifest,
	CutoverDestination,
	MarkCount,
	OwnerAuth,
	Site,
	WriteMarkWorker
} from '../ports';
import { PermanentError } from '../step';
import { reseedStatement } from '../vendor/drangler/delta';
import { ChangeScan } from './change-scan';
import { DNS_UNREADABLE, pointsAt, routeNotSeen, type DnsReader } from './cutover-dns';
import {
	changesManifestSchema,
	changesProgressSchema,
	cutoverKeys,
	digestOfParts,
	keyParts,
	manifestOfMarker,
	markOf,
	readCopy,
	sha256Hex,
	type ChangesProgress
} from './cutover-store';

export interface CutoverDestinationDeps {
	backups: Pick<BackupLedger, 'site'>;
	custody: Pick<Custody, 'sealed' | 'withOwnerToken'>;
	worker: Pick<BackupWorker, 'restore' | 'importState' | 'importReason'>;
	site: Pick<Site, 'probe'>;
	blobs: Pick<BackupBlobs, 'get' | 'put' | 'deletePrefix'>;
	marks: WriteMarkWorker;
	dns: DnsReader;
	sleep(ms: number): Promise<void>;
	now(): number;
	ceilingBytes?: number;
	// how long a promote waits for the site to apply the data, and how long a route waits for DNS
	applyWaitMs?: number;
	applyPollMs?: number;
	routeWaitMs?: number;
	routePollMs?: number;
	// the parts a saved change list is cut into, and the most it may hold
	partBytes?: number;
	changesLimitBytes?: number;
	// the journal writes one request reads
	windowWrites?: number;
}

// the worker routes the destination still needs; while any is listed the start stays closed
export const CUTOVER_MISSING_CONTRACTS: readonly string[] = [];

// unreviewed: a stop for a runaway stream, not a measurement
export const CHANGES_LIMIT_BYTES = 1024 * 1024 * 1024;

// unreviewed: journal writes read per request, so a long list is many requests
export const CHANGE_WINDOW_WRITES = 10_000;

export const DESTINATION_REFUSALS = {
	needsUpdate:
		'The new site needs an update before it can take a move. Update the site, then start the move again.',
	countNotStarted:
		'The new site could not start counting the changes it accepts, so your address was not moved to it.',
	countLost:
		'The new site no longer has its count of accepted changes, so Drupflare cannot tell whether the move can still be undone.',
	exportDialect:
		'Your old site does not use MySQL or MariaDB, and the saved changes are written for those, so they cannot be saved for it.',
	exportTooLarge: 'The new changes are too large to save as one file.',
	exportCutShort: 'The list of new changes ended before it was complete.',
	exportMissing: 'The saved list of new changes is missing or damaged.',
	exportSince:
		'The new site cannot list only the changes after the first file, so the last changes were not saved.',
	notLive: 'The new site is not live, so it cannot take your address.',
	notAnswering: 'The new site did not answer, so it was not checked.',
	copyMissing: 'The saved copy of your old site is missing or damaged. Start the move again.',
	tooLarge: 'The copy of your old site is larger than the new site accepts in one load.',
	deltaScope:
		'The latest changes touch data that a move does not carry, so they were not applied.',
	notApplied: 'The new site could not load the copy of your old site.'
} as const;

const TOUCHED =
	/^\s*(?:DROP TABLE(?: IF EXISTS)?|CREATE TABLE(?: IF NOT EXISTS)?|INSERT(?: OR REPLACE)? INTO)\s+[`"[]?([A-Za-z0-9_]+)/gim;

// the tables a converted change copy writes to, in the order they first appear
export function tablesTouched(sql: string): string[] {
	const seen = new Set<string>();
	for (const found of sql.matchAll(TOUCHED)) seen.add(found[1]!);
	return [...seen];
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// #region reading the count

// zero means zero only when the site answered with our mark and a count of zero. A site that has
// no mark, a different mark, or a failed capture that left the count at zero is never read as zero
export function countFrom(
	reading: MarkCount | 'none' | 'missing',
	mark: string
): { writes: number } | { problem: string } {
	if (reading === 'none' || reading === 'missing')
		return { problem: DESTINATION_REFUSALS.countLost };
	if (reading.mark !== mark) return { problem: DESTINATION_REFUSALS.countLost };
	if (reading.incomplete !== null && reading.writes === 0) {
		return { problem: DESTINATION_REFUSALS.countLost };
	}
	return { writes: reading.writes };
}

const KNOWN_LIMITS: [RegExp, (found: RegExpExecArray) => string][] = [
	[/^sessions$/, () => 'Sign-in sessions'],
	[
		/^settings and state kept in key-value storage$/,
		() => 'Settings and state that Drupal keeps in key-value storage'
	],
	[
		/^the bytes of (\d+) /,
		(found) =>
			`The files themselves (${found[1]} new, replaced or removed); only the records of them are saved`
	],
	[/^structure changes to /, () => 'Changes to the structure of the database'],
	[/^rows in .*no key to export by/, () => 'Changes to data that has no key to identify a row']
];

// the owner reads these, so a table name or an error code from the site never passes through
export function exportNotes(manifest: ChangeManifest, lateWrites: number): string[] {
	const notes: string[] = [];
	if (manifest.incomplete !== null) {
		notes.push(
			'Some changes could not be recorded, so this file is not a full account of what the new site accepted'
		);
	}
	const seen = new Set<string>();
	for (const item of manifest.cannotCarry) {
		const known = KNOWN_LIMITS.map(([pattern, plain]) => {
			const found = pattern.exec(item);
			return found === null ? null : plain(found);
		}).find((plain) => plain !== null);
		seen.add(known ?? 'Other changes the new site could not describe');
	}
	notes.push(...seen);
	notes.push(
		lateWrites > 0
			? `${lateWrites} ${lateWrites === 1 ? 'change' : 'changes'} the new site accepted after the file was saved`
			: 'Changes the new site accepts after the file is saved, while visitors still reach it'
	);
	return notes;
}

// #endregion

export function createCutoverDestination(
	deps: CutoverDestinationDeps,
	siteId: string
): CutoverDestination {
	const ceiling = deps.ceilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
	const applyWait = deps.applyWaitMs ?? 120_000;
	const applyPoll = deps.applyPollMs ?? 3_000;
	const routeWait = deps.routeWaitMs ?? 240_000;
	const routePoll = deps.routePollMs ?? 15_000;

	const open = async () => {
		const row = await deps.backups.site(siteId);
		if (row === null || row.state !== 'active' || row.primaryHostname === null) {
			throw new PermanentError('destination_not_live', DESTINATION_REFUSALS.notLive);
		}
		const { ownerTokenId } = await deps.custody.sealed(siteId);
		if (ownerTokenId === null) {
			throw new PermanentError('destination_not_live', DESTINATION_REFUSALS.notLive);
		}
		return { orgId: row.organizationId, hostname: row.primaryHostname, ownerTokenId };
	};

	const withToken = <T>(ownerTokenId: string, use: (bearer: string) => Promise<T>) =>
		deps.custody.withOwnerToken(siteId, ownerTokenId, use);

	// both copies read back whole and checked against their manifests; null names the plain problem
	async function copies(key: string, snapshot: string, delta: string, orgId: string) {
		const { operationId } = keyParts(key);
		const [first, second] = await Promise.all([
			manifestOfMarker(deps.blobs, orgId, operationId, snapshot),
			manifestOfMarker(deps.blobs, orgId, operationId, delta)
		]);
		if (first === null || second === null) return { problem: DESTINATION_REFUSALS.copyMissing };
		if (first.manifest.label !== 'snapshot' || second.manifest.label === 'snapshot') {
			return { problem: DESTINATION_REFUSALS.copyMissing };
		}
		const [base, changes] = await Promise.all([
			readCopy(deps.blobs, first.copy, first.manifest),
			readCopy(deps.blobs, second.copy, second.manifest)
		]);
		if (base === null || changes === null) return { problem: DESTINATION_REFUSALS.copyMissing };
		const carried = new Set(second.manifest.tables ?? []);
		if (tablesTouched(text(changes)).some((table) => !carried.has(table))) {
			return { problem: DESTINATION_REFUSALS.deltaScope };
		}
		const body = joinParts([base, changes, utf8(`\n${reseedStatement()}\n`)]);
		if (!restorable(body.byteLength, ceiling))
			return { problem: DESTINATION_REFUSALS.tooLarge };
		return { body };
	}

	// the count of one move, read from the new site and judged against that move's mark
	async function count(key: string) {
		const site = await open();
		const mark = markOf(keyParts(key).operationId);
		const reading = await withToken(site.ownerTokenId, (bearer) =>
			deps.marks.read(site.hostname, { bearer })
		);
		const judged = countFrom(reading, mark);
		if ('problem' in judged) throw new PermanentError('write_count_lost', judged.problem);
		return { site, writes: judged.writes };
	}

	// the saved parts of the change list, one pass; the whole list is never held
	async function saveChanges(
		stream: ReadableStream<Uint8Array>,
		prefix: string,
		// the part number to start at and the bytes already saved before it
		from = { part: 0, bytes: 0 }
	): Promise<{ hashes: string[]; bytes: number; scan: ChangeScan }> {
		const partBytes = deps.partBytes ?? PART_BYTES;
		const limit = (deps.changesLimitBytes ?? CHANGES_LIMIT_BYTES) - from.bytes;
		const scan = new ChangeScan();
		const buffer = new Uint8Array(partBytes);
		const hashes: string[] = [];
		let filled = 0;
		let bytes = 0;
		const flush = async () => {
			const part = buffer.slice(0, filled);
			await deps.blobs.put(partKey(prefix, from.part + hashes.length, 'sql'), part);
			hashes.push(await sha256Hex(part));
			filled = 0;
		};
		const reader = stream.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel().catch(() => undefined);
				throw new PermanentError('export_too_large', DESTINATION_REFUSALS.exportTooLarge);
			}
			scan.push(value);
			let at = 0;
			while (at < value.byteLength) {
				const take = Math.min(value.byteLength - at, partBytes - filled);
				buffer.set(value.subarray(at, at + take), filled);
				filled += take;
				at += take;
				if (filled === partBytes) await flush();
			}
		}
		if (filled > 0) await flush();
		return { hashes, bytes, scan };
	}

	// the hashes of saved parts read back in order; null when one is gone
	async function savedHashes(prefix: string, first: number, count: number) {
		const hashes: string[] = [];
		for (let at = 0; at < count; at++) {
			const bytes = await deps.blobs.get(partKey(prefix, first + at, 'sql'));
			if (bytes === null) return null;
			hashes.push(await sha256Hex(bytes));
		}
		return hashes;
	}

	// a saved read that still matches its parts, or null so the read starts over
	async function resumable(
		prefix: string,
		read: 'first' | 'final',
		since: number,
		firstPart: number
	): Promise<ChangesProgress | null> {
		const stored = await deps.blobs.get(cutoverKeys.progress(prefix, read));
		if (stored === null) return null;
		let parsed: ReturnType<typeof changesProgressSchema.safeParse>;
		try {
			parsed = changesProgressSchema.safeParse(JSON.parse(text(stored)));
		} catch {
			return null;
		}
		if (!parsed.success || parsed.data.since !== since) return null;
		const hashes = await savedHashes(prefix, firstPart, parsed.data.hashes.length);
		const same = hashes?.every((hash, at) => hash === parsed.data.hashes[at]);
		return same === true ? parsed.data : null;
	}

	// reads the list in windows of journal writes, each request with its own time. A window is saved
	// as its own parts and checked by its closing line before the cursor moves, so a window that
	// stalls is read again from its own cursor and a replay carries on from the last saved one
	async function readWindows(
		site: { hostname: string },
		auth: OwnerAuth,
		prefix: string,
		read: 'first' | 'final',
		start: ChangesProgress,
		base: { parts: number; bytes: number }
	): Promise<ChangesProgress> {
		const width = deps.windowWrites ?? CHANGE_WINDOW_WRITES;
		let state = start;
		// a read of nothing still saves its one window, so the file is never empty
		while (state.cursor < state.target || state.hashes.length === 0) {
			const from = state.cursor;
			let until = Math.min(from + width, state.target);
			let body = await deps.marks.body(site.hostname, until, auth, from);
			// a site that ignores since can only be read whole from the start
			if (body.since === -1 && from === 0 && until < state.target) {
				await body.stream.cancel().catch(() => undefined);
				until = state.target;
				body = await deps.marks.body(site.hostname, until, auth, from);
			}
			if (body.through !== until) {
				await body.stream.cancel().catch(() => undefined);
				throw new Error('the site read the changes to a different point than asked');
			}
			if (body.since !== from && !(from === 0 && body.since === -1)) {
				await body.stream.cancel().catch(() => undefined);
				throw new PermanentError('export_since', DESTINATION_REFUSALS.exportSince);
			}
			const saved = await saveChanges(body.stream, prefix, {
				part: base.parts + state.hashes.length,
				bytes: base.bytes + state.bytes
			});
			const scanned = saved.scan.result();
			if (!scanned.complete) throw new Error(DESTINATION_REFUSALS.exportCutShort);
			state = {
				...state,
				cursor: until,
				bytes: state.bytes + saved.bytes,
				statements: state.statements + scanned.statements,
				hashes: [...state.hashes, ...saved.hashes],
				incomplete: state.incomplete ?? body.incomplete
			};
			await deps.blobs.put(cutoverKeys.progress(prefix, read), utf8(JSON.stringify(state)));
		}
		return state;
	}

	return {
		async validate(key, snapshot, delta) {
			const site = await open().catch((error: unknown) => {
				if (error instanceof PermanentError) return error;
				throw error;
			});
			if (site instanceof PermanentError) return site.message;
			const { status } = await withToken(site.ownerTokenId, (bearer) =>
				deps.site.probe(site.hostname, '/health', undefined, { bearer })
			);
			if (status !== 200) return DESTINATION_REFUSALS.notAnswering;
			// a site that cannot count its writes cannot say whether the move can be undone
			const counts = await withToken(site.ownerTokenId, (bearer) =>
				deps.marks.supported(site.hostname, { bearer })
			);
			if (!counts) return DESTINATION_REFUSALS.needsUpdate;
			const loaded = await copies(key, snapshot, delta, site.orgId);
			return 'problem' in loaded ? (loaded.problem ?? null) : null;
		},

		async promote(key, snapshot, delta) {
			const site = await open();
			const { operationId } = keyParts(key);
			const loaded = await copies(key, snapshot, delta, site.orgId);
			if ('problem' in loaded)
				throw new PermanentError('promote_refused', loaded.problem ?? '');
			const label = `promote-${operationId}`;
			const mark = markOf(operationId);
			// false only when the restore answered without the mark, which is a site that predates it
			let asked = true;
			const state = await withToken(site.ownerTokenId, async (bearer) => {
				const auth = { bearer };
				if ((await deps.worker.importState(site.hostname, label, auth)) === 'absent') {
					const sent = await deps.worker.restore(
						site.hostname,
						loaded.body!,
						label,
						auth,
						mark
					);
					asked = sent.mark === mark;
				}
				const deadline = deps.now() + applyWait;
				for (;;) {
					const now = await deps.worker.importState(site.hostname, label, auth);
					if (now === 'applied' || now === 'failed') return now;
					if (deps.now() >= deadline) return now;
					await deps.sleep(applyPoll);
				}
			});
			if (state === 'failed') {
				throw new PermanentError('promote_failed', DESTINATION_REFUSALS.notApplied);
			}
			if (state !== 'applied') throw new Error('the new site has not applied the copy yet');
			if (!asked) return { counting: false };
			// the site says whether the count is open, so a count lost after the copy is started again
			const reading = await withToken(site.ownerTokenId, (bearer) =>
				deps.marks.read(site.hostname, { bearer })
			);
			return { counting: typeof reading === 'object' && reading.mark === mark };
		},

		// the address belongs to the owner's zone, so the owner moves it and this waits to see it move
		async route(_key, to, hostname) {
			const site = await open();
			const deadline = deps.now() + routeWait;
			let read = false;
			for (;;) {
				try {
					const points = await pointsAt(deps.dns, hostname, site.hostname);
					read = true;
					if (points === (to === 'destination')) return;
				} catch {
					// a lookup that fails is tried again until the time is up
				}
				if (deps.now() >= deadline) {
					if (!read) throw new Error(DNS_UNREADABLE);
					throw routeNotSeen(to);
				}
				await deps.sleep(routePoll);
			}
		},

		// a repeat names the same mark, so the site keeps its count and answers that it exists
		async startCounting(key) {
			const site = await open();
			const mark = markOf(keyParts(key).operationId);
			const started = await withToken(site.ownerTokenId, (bearer) =>
				deps.marks.start(site.hostname, mark, { bearer })
			);
			if (started === 'taken' || started === 'missing') {
				throw new PermanentError(
					'write_count_not_started',
					DESTINATION_REFUSALS.countNotStarted
				);
			}
		},

		async stopCounting(key) {
			const site = await open();
			const mark = markOf(keyParts(key).operationId);
			await withToken(site.ownerTokenId, (bearer) =>
				deps.marks.end(site.hostname, mark, { bearer })
			);
		},

		async acceptedWrites(key) {
			return (await count(key)).writes;
		},

		// a health answer without the write count would let a move look safe to undo, so the count
		// is read first and a failure there fails the check
		async observe(key) {
			const { site, writes } = await count(key);
			const { status } = await withToken(site.ownerTokenId, (bearer) =>
				deps.site.probe(site.hostname, '/health', undefined, { bearer })
			);
			return { healthy: status === 200, writes };
		},

		async exportChanges(key, dialect) {
			if (dialect !== 'mysql') {
				throw new PermanentError('export_dialect', DESTINATION_REFUSALS.exportDialect);
			}
			const site = await open();
			const { operationId } = keyParts(key);
			const mark = markOf(operationId);
			const prefix = cutoverKeys.changes(site.orgId, operationId);
			return withToken(site.ownerTokenId, async (bearer) => {
				const auth = { bearer };
				const kept = await resumable(prefix, 'first', 0, 0);
				// a kept read is taken up at the point it reached, so a replay holds the same list
				const first = await deps.marks.manifest(site.hostname, auth, kept?.target);
				if (typeof first === 'string' || first.mark !== mark) {
					throw new PermanentError('write_count_lost', DESTINATION_REFUSALS.countLost);
				}
				// a read with nothing kept starts over, so old parts never mix with these
				if (kept === null) await deps.blobs.deletePrefix(prefix);
				const done = await readWindows(
					site,
					auth,
					prefix,
					'first',
					kept ?? {
						since: 0,
						target: first.through,
						cursor: 0,
						bytes: 0,
						statements: 0,
						hashes: [],
						incomplete: null
					},
					{ parts: 0, bytes: 0 }
				);
				const after = await deps.marks.manifest(site.hostname, auth);
				const writes = typeof after === 'string' ? first.writes : after.writes;
				const manifest = { ...first, incomplete: first.incomplete ?? done.incomplete };
				await deps.blobs.put(
					cutoverKeys.manifest(prefix),
					utf8(
						JSON.stringify({
							parts: done.hashes.length,
							bytes: done.bytes,
							digest: await digestOfParts(done.hashes),
							statements: done.statements,
							through: done.target,
							takenAt: deps.now()
						})
					)
				);
				return {
					reference: prefix,
					cannotCarry: exportNotes(manifest, Math.max(0, writes - done.target)),
					through: done.target
				};
			});
		},

		// the first file's parts stay as they are and the new ones continue the numbering, so the one
		// download reads both. Run again, it replaces the new parts and leaves the first alone
		async exportFinalChanges(key, dialect, since) {
			if (dialect !== 'mysql') {
				throw new PermanentError('export_dialect', DESTINATION_REFUSALS.exportDialect);
			}
			const site = await open();
			const { operationId } = keyParts(key);
			const mark = markOf(operationId);
			const prefix = cutoverKeys.changes(site.orgId, operationId);
			const stored = await deps.blobs.get(cutoverKeys.manifest(prefix));
			const parsed =
				stored === null ? null : changesManifestSchema.safeParse(JSON.parse(text(stored)));
			if (parsed === null || !parsed.success) {
				throw new PermanentError('export_missing', DESTINATION_REFUSALS.exportMissing);
			}
			const total = parsed.data;
			const earlier = total.final;
			const base = {
				parts: total.parts - (earlier?.parts ?? 0),
				bytes: total.bytes - (earlier?.bytes ?? 0),
				statements: total.statements - (earlier?.statements ?? 0)
			};
			// the first file is read back whole, so a part lost since the first read is found now
			const hashes = await savedHashes(prefix, 0, base.parts);
			if (hashes === null) {
				throw new PermanentError('export_missing', DESTINATION_REFUSALS.exportMissing);
			}
			const kept = await resumable(prefix, 'final', since, base.parts);
			return withToken(site.ownerTokenId, async (bearer) => {
				const auth = { bearer };
				const latest = await deps.marks.manifest(site.hostname, auth);
				if (typeof latest === 'string' || latest.mark !== mark) {
					throw new PermanentError('write_count_lost', DESTINATION_REFUSALS.countLost);
				}
				const finish = async (
					extra: { hashes: string[]; bytes: number; statements: number },
					through: number
				) => {
					const manifest = {
						parts: base.parts + extra.hashes.length,
						bytes: base.bytes + extra.bytes,
						digest: await digestOfParts([...hashes, ...extra.hashes]),
						statements: base.statements + extra.statements,
						through,
						takenAt: total.takenAt,
						final: {
							since,
							parts: extra.hashes.length,
							bytes: extra.bytes,
							statements: extra.statements,
							takenAt: deps.now()
						}
					};
					await deps.blobs.put(
						cutoverKeys.manifest(prefix),
						utf8(JSON.stringify(manifest))
					);
					return {
						cannotCarry: exportNotes(latest, 0),
						statements: extra.statements
					};
				};
				// a kept read finishes at the point it reached, so a replay holds the same list
				const target = kept?.target ?? latest.through;
				if (target <= since) {
					return finish({ hashes: [], bytes: 0, statements: 0 }, latest.through);
				}
				const done = await readWindows(
					site,
					auth,
					prefix,
					'final',
					kept ?? {
						since,
						target,
						cursor: since,
						bytes: 0,
						statements: 0,
						hashes: [],
						incomplete: null
					},
					{ parts: base.parts, bytes: base.bytes }
				);
				return finish(done, done.target);
			});
		}
	};
}
