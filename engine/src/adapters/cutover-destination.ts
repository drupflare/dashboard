import { utf8 } from '@contracts/common';
import { DEFAULT_RESTORE_CEILING_BYTES, joinParts, restorable } from '../backup-parts';
import type { Custody } from '../custody';
import type { BackupBlobs, BackupLedger, BackupWorker, CutoverDestination, Site } from '../ports';
import { PermanentError } from '../step';
import { reseedStatement } from '../vendor/drangler/delta';
import { DNS_UNREADABLE, pointsAt, routeNotSeen, type DnsReader } from './cutover-dns';
import { keyParts, manifestOfMarker, readCopy } from './cutover-store';

export interface CutoverDestinationDeps {
	backups: Pick<BackupLedger, 'site'>;
	custody: Pick<Custody, 'sealed' | 'withOwnerToken'>;
	worker: Pick<BackupWorker, 'restore' | 'importState' | 'importReason'>;
	site: Pick<Site, 'probe'>;
	blobs: Pick<BackupBlobs, 'get'>;
	dns: DnsReader;
	sleep(ms: number): Promise<void>;
	now(): number;
	ceilingBytes?: number;
	// how long a promote waits for the site to apply the data, and how long a route waits for DNS
	applyWaitMs?: number;
	applyPollMs?: number;
	routeWaitMs?: number;
	routePollMs?: number;
}

// the worker routes the destination still needs; while any is listed the start stays closed
export const CUTOVER_MISSING_CONTRACTS: readonly string[] = ['accepted-writes', 'changes-since'];

export const DESTINATION_REFUSALS = {
	writesUnknown:
		'The new site cannot report how many changes it has taken since the move yet, so Drupflare cannot tell whether the move can still be undone.',
	changesUnknown:
		'The new site cannot export only the changes it took since the move yet, so Drupflare cannot save them for your old site.',
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

	const refuse = (message: string) => new PermanentError('worker_contract_missing', message);

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
			const state = await withToken(site.ownerTokenId, async (bearer) => {
				const auth = { bearer };
				if ((await deps.worker.importState(site.hostname, label, auth)) === 'absent') {
					await deps.worker.restore(site.hostname, loaded.body!, label, auth);
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

		async acceptedWrites() {
			throw refuse(DESTINATION_REFUSALS.writesUnknown);
		},

		// a health answer without the write count would let a move look safe to undo
		async observe() {
			throw refuse(DESTINATION_REFUSALS.writesUnknown);
		},

		async exportChanges() {
			throw refuse(DESTINATION_REFUSALS.changesUnknown);
		}
	};
}
