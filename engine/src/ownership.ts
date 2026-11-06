import type { D1Database } from '@cloudflare/workers-types';
import { scriptName, type SitePlane } from '@contracts/sites';
import type { AccountRoute, Cloudflare, EngineDeps, ScriptUpload } from './ports';
import { RESOURCE_SPECS, type ResourceKind } from './provision-plan';
import { PermanentError } from './step';

// #region the ledger

export const OWNED_KINDS = ['kv', 'r2', 'd1', 'script', 'route'] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number];
export type RowState = 'intent' | 'live' | 'missing' | 'deleted';

export interface LedgerRow {
	id: string;
	siteId: string;
	accountId: string;
	kind: OwnedKind;
	binding: string;
	name: string;
	providerId: string | null;
	createdByOperation: string;
	createdAt: number;
	missingAt: number | null;
	deletedAt: number | null;
	fingerprint: string | null;
}

export function stateOf(row: LedgerRow): RowState {
	if (row.deletedAt !== null) return 'deleted';
	if (row.providerId === null) return 'intent';
	return row.missingAt === null ? 'live' : 'missing';
}

export interface NewIntent {
	siteId: string;
	accountId: string;
	kind: OwnedKind;
	binding: string;
	name: string;
	operationId: string;
}

// a row with no provider id is an intent: the engine said it would create the thing and has not
// yet recorded what it made
export interface ResourceLedger {
	live(siteId: string): Promise<LedgerRow[]>;
	all(siteId: string): Promise<LedgerRow[]>;
	account(accountId: string): Promise<LedgerRow[]>;
	intend(intent: NewIntent, now: number): Promise<{ row: LedgerRow; created: boolean }>;
	fill(id: string, providerId: string, fingerprint?: string | null): Promise<void>;
	markMissing(id: string, now: number): Promise<void>;
	markDeleted(id: string, now: number): Promise<void>;
}

type Row = {
	id: string;
	site_id: string;
	account_id: string;
	kind: string;
	binding: string;
	name: string;
	provider_id: string | null;
	created_by_operation: string;
	created_at: number;
	missing_at: number | null;
	deleted_at: number | null;
	fingerprint: string | null;
};

const COLUMNS = `id, site_id, account_id, kind, binding, name, provider_id, created_by_operation,
	created_at, missing_at, deleted_at, fingerprint`;

function toRow(row: Row): LedgerRow {
	return {
		id: row.id,
		siteId: row.site_id,
		accountId: row.account_id,
		kind: row.kind as OwnedKind,
		binding: row.binding,
		name: row.name,
		providerId: row.provider_id,
		createdByOperation: row.created_by_operation,
		createdAt: row.created_at,
		missingAt: row.missing_at,
		deletedAt: row.deleted_at,
		fingerprint: row.fingerprint
	};
}

const isUnique = (error: unknown) =>
	error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export class D1ResourceLedger implements ResourceLedger {
	constructor(private readonly db: D1Database) {}

	private async select(where: string, ...params: unknown[]): Promise<LedgerRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${COLUMNS} FROM site_resources WHERE ${where} ORDER BY created_at, rowid`
			)
			.bind(...params)
			.all<Row>();
		return results.map(toRow);
	}

	live(siteId: string) {
		return this.select('site_id = ? AND deleted_at IS NULL', siteId);
	}

	all(siteId: string) {
		return this.select('site_id = ?', siteId);
	}

	account(accountId: string) {
		return this.select('account_id = ? AND deleted_at IS NULL', accountId);
	}

	async intend(intent: NewIntent, now: number) {
		const known = (await this.live(intent.siteId)).find(
			(row) => row.binding === intent.binding
		);
		if (known !== undefined) return { row: known, created: false };
		const row: LedgerRow = {
			id: `res_${crypto.randomUUID().replaceAll('-', '')}`,
			siteId: intent.siteId,
			accountId: intent.accountId,
			kind: intent.kind,
			binding: intent.binding,
			name: intent.name,
			providerId: null,
			createdByOperation: intent.operationId,
			createdAt: now,
			missingAt: null,
			deletedAt: null,
			fingerprint: null
		};
		try {
			await this.db
				.prepare(
					`INSERT INTO site_resources (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`
				)
				.bind(
					row.id,
					row.siteId,
					row.accountId,
					row.kind,
					row.binding,
					row.name,
					row.createdByOperation,
					row.createdAt
				)
				.run();
		} catch (error) {
			if (!isUnique(error)) throw error;
			const winner = (await this.live(intent.siteId)).find(
				(live) => live.binding === intent.binding
			);
			if (winner === undefined) throw error;
			return { row: winner, created: false };
		}
		return { row, created: true };
	}

	async fill(id: string, providerId: string, fingerprint: string | null = null) {
		let changes = 0;
		try {
			const result = await this.db
				.prepare(
					`UPDATE site_resources SET provider_id = ?, fingerprint = COALESCE(?, fingerprint)
					WHERE id = ? AND deleted_at IS NULL AND (provider_id IS NULL OR provider_id = ?)`
				)
				.bind(providerId, fingerprint, id, providerId)
				.run();
			changes = result.meta.changes;
		} catch (error) {
			if (!isUnique(error)) throw error;
		}
		if (changes !== 1) throw new LedgerConflictError(id, providerId);
	}

	async markMissing(id: string, now: number) {
		await this.db
			.prepare(
				'UPDATE site_resources SET missing_at = ? WHERE id = ? AND deleted_at IS NULL AND missing_at IS NULL'
			)
			.bind(now, id)
			.run();
	}

	async markDeleted(id: string, now: number) {
		await this.db
			.prepare('UPDATE site_resources SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
			.bind(now, id)
			.run();
	}
}

// #endregion

// #region typed refusals

export class LedgerConflictError extends PermanentError {
	constructor(id: string, providerId: string) {
		super('ledger_conflict', `row ${id} cannot take provider id ${providerId}`);
	}
}

export class ForeignResourceError extends PermanentError {
	constructor(
		readonly kind: OwnedKind,
		readonly resource: string,
		readonly reason: 'no_intent' | 'other_operation'
	) {
		super(
			'foreign_resource',
			reason === 'no_intent'
				? `${kind} ${resource} already exists and this site never recorded creating it`
				: `${kind} ${resource} has an unfinished record from another operation`
		);
	}
}

export class NotOwnedError extends PermanentError {
	constructor(ref: { siteId: string; kind: OwnedKind; id: string; action: string }) {
		super(
			'not_owned',
			`${ref.siteId} has no live ledger row for ${ref.kind} ${ref.id}, so it will not ${ref.action} it`
		);
	}
}

export class ResourceMissingError extends PermanentError {
	constructor(row: LedgerRow) {
		super(
			'resource_missing',
			`${row.kind} ${row.name} is in the ledger but gone from the account; it is reported and left alone`
		);
	}
}

export class IntentUnresolvedError extends PermanentError {
	constructor(row: LedgerRow) {
		super(
			'intent_unresolved',
			`${row.kind} ${row.name} has an intent and no recorded id, so there is nothing safe to delete`
		);
	}
}

export class ScriptChangedError extends PermanentError {
	constructor(
		readonly script: string,
		readonly why: 'tag' | 'version'
	) {
		super(
			'script_changed',
			`script ${script} was changed by someone else (its ${why} differs from the record)`
		);
	}
}

export class WildcardRouteError extends PermanentError {
	constructor(hostname: string) {
		super(
			'route_wildcard',
			`${hostname} has a wildcard; a customer zone only gets an exact host`
		);
	}
}

export class RouteShadowError extends PermanentError {
	constructor(pattern: string, other: AccountRoute) {
		super(
			'route_shadow',
			`${pattern} would shadow ${other.pattern}, which belongs to script ${other.script ?? '(none)'}`
		);
	}
}

export const OWNERSHIP_ERROR_CODES = [
	'ledger_conflict',
	'foreign_resource',
	'not_owned',
	'resource_missing',
	'intent_unresolved',
	'script_changed',
	'route_wildcard',
	'route_shadow'
] as const;

// #endregion

// #region the guard

export interface OwnedRef {
	siteId: string;
	accountId: string;
	kind: OwnedKind;
	id: string;
	action: 'create' | 'update' | 'delete';
	operationId?: string;
}

// the dispatch namespace holds only our scripts, so a managed site's one script name is ours by
// construction; nothing else gets that exemption
const inNamespace = (plane: SitePlane, ref: OwnedRef) =>
	plane === 'managed' && ref.kind === 'script' && ref.id === scriptName(ref.siteId);

// returns the row that authorizes the change, or null when the namespace rule does
export function assertOwned(
	plane: SitePlane,
	ref: OwnedRef,
	rows: readonly LedgerRow[]
): LedgerRow | null {
	const mine = rows.filter(
		(row) =>
			row.siteId === ref.siteId &&
			row.accountId === ref.accountId &&
			row.kind === ref.kind &&
			row.deletedAt === null
	);
	if (ref.action === 'create') {
		const intent = mine.find((row) => row.providerId === null && row.name === ref.id);
		if (intent === undefined) {
			if (inNamespace(plane, ref)) return null;
			throw new NotOwnedError(ref);
		}
		if (ref.operationId !== undefined && intent.createdByOperation !== ref.operationId) {
			throw new ForeignResourceError(ref.kind, ref.id, 'other_operation');
		}
		return intent;
	}
	const row = mine.find((candidate) => candidate.providerId === ref.id);
	if (row === undefined) {
		if (inNamespace(plane, ref)) return null;
		throw new NotOwnedError(ref);
	}
	if (row.missingAt !== null) throw new ResourceMissingError(row);
	return row;
}

type Guarded = Pick<EngineDeps, 'cloudflare' | 'ledger' | 'now'>;

export interface Claim {
	siteId: string;
	accountId: string;
	operationId: string;
	plane: SitePlane;
}

export const siteTag = (siteId: string) => `s:${siteId}`;

export const routeRef = (zoneId: string, routeId: string) => `${zoneId}:${routeId}`;

function splitRoute(id: string): [string, string] {
	const at = id.indexOf(':');
	return [id.slice(0, at), id.slice(at + 1)];
}

// every delete goes by an id that a live ledger row of this site names
export async function ownedDelete(
	deps: Guarded,
	plane: SitePlane,
	ref: Omit<OwnedRef, 'action'>
): Promise<'deleted' | 'absent'> {
	assertOwned(plane, { ...ref, action: 'delete' }, await deps.ledger.live(ref.siteId));
	if (ref.kind === 'script') {
		const info = await deps.cloudflare.getScript(ref.id);
		if (info === null) return 'absent';
		if (!info.tags.includes(siteTag(ref.siteId))) throw new ScriptChangedError(ref.id, 'tag');
		return deps.cloudflare.deleteScript(ref.id);
	}
	if (ref.kind === 'route') return deps.cloudflare.removeRoute(...splitRoute(ref.id));
	return deps.cloudflare.deleteResource(ref.kind, ref.id);
}

// #endregion

// #region creating what the site owns

const rowOf = (rows: readonly LedgerRow[], binding: string) =>
	rows.find((row) => row.binding === binding);

export async function claimResource(
	deps: Guarded,
	claim: Claim,
	spec: { kind: ResourceKind; binding: string; name: string }
): Promise<LedgerRow> {
	const { cloudflare, ledger, now } = deps;
	let row = rowOf(await ledger.live(claim.siteId), spec.binding);
	if (row !== undefined) {
		if (row.missingAt !== null) {
			// a managed site may recreate what is gone; a customer's account never does it silently
			if (claim.plane !== 'managed') throw new ResourceMissingError(row);
			await ledger.markDeleted(row.id, now());
			row = undefined;
		} else if (row.providerId !== null) {
			return row;
		} else if (row.createdByOperation !== claim.operationId) {
			throw new ForeignResourceError(spec.kind, spec.name, 'other_operation');
		}
	}
	const found = await cloudflare.findResource(spec.kind, spec.name);
	if (row === undefined) {
		// nothing of ours has this name yet, so whatever holds it is not ours
		if (found !== null) throw new ForeignResourceError(spec.kind, spec.name, 'no_intent');
		row = (await ledger.intend({ ...claim, ...spec, operationId: claim.operationId }, now()))
			.row;
	}
	// an intent of this operation proves a resource of that exact name is the one it made
	const providerId =
		found?.providerId ?? (await cloudflare.createResource(spec.kind, spec.name)).providerId;
	await ledger.fill(row.id, providerId);
	return { ...row, providerId };
}

// the script is claimed before its assets upload, since the asset session is a change to it
export async function claimScript(
	deps: Guarded,
	claim: Claim,
	options: { overwriteChanged?: boolean } = {}
): Promise<void> {
	const { cloudflare, ledger, now } = deps;
	const name = scriptName(claim.siteId);
	const intend = () =>
		ledger.intend({ ...claim, kind: 'script', binding: 'SCRIPT', name }, now());
	let row = (await ledger.live(claim.siteId)).find((live) => live.kind === 'script');
	const info = await cloudflare.getScript(name);
	const ours = info !== null && info.tags.includes(siteTag(claim.siteId));
	if (row === undefined) {
		if (info !== null) throw new ForeignResourceError('script', name, 'no_intent');
		await intend();
		return;
	}
	if (row.missingAt !== null) {
		if (claim.plane !== 'managed') throw new ResourceMissingError(row);
		await ledger.markDeleted(row.id, now());
		await intend();
		return;
	}
	if (row.providerId === null) {
		if (row.createdByOperation !== claim.operationId) {
			throw new ForeignResourceError('script', name, 'other_operation');
		}
		if (info !== null && !ours) throw new ForeignResourceError('script', name, 'no_intent');
		return;
	}
	if (info === null) {
		if (claim.plane !== 'managed') {
			await ledger.markMissing(row.id, now());
			throw new ResourceMissingError(row);
		}
		await ledger.markDeleted(row.id, now());
		await intend();
		return;
	}
	if (!ours) throw new ScriptChangedError(name, 'tag');
	if (!options.overwriteChanged && row.fingerprint !== null && info.version !== row.fingerprint) {
		throw new ScriptChangedError(name, 'version');
	}
}

export async function ownedPutScript(
	deps: Guarded,
	claim: Claim,
	upload: ScriptUpload,
	options: { overwriteChanged?: boolean } = {}
): Promise<{ versionId: string | null }> {
	const { cloudflare, ledger } = deps;
	const name = scriptName(claim.siteId);
	await claimScript(deps, claim, options);
	const row = (await ledger.live(claim.siteId)).find((live) => live.kind === 'script');
	assertOwned(
		claim.plane,
		{
			...claim,
			kind: 'script',
			id: name,
			action: row?.providerId === null ? 'create' : 'update'
		},
		row === undefined ? [] : [row]
	);
	const tags = [...new Set([...(upload.metadata.tags ?? []), siteTag(claim.siteId)])];
	const result = await cloudflare.putScript(name, {
		...upload,
		metadata: { ...upload.metadata, tags }
	});
	const after = await cloudflare.getScript(name);
	if (row !== undefined) await ledger.fill(row.id, name, after?.version ?? null);
	return result;
}

// a route on a customer's zone: exact host only, and never over another script's route
export const routePattern = (hostname: string) => `${hostname}/*`;

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
	return new RegExp(`^${escaped}$`, 'i');
}

function splitPattern(pattern: string): { host: string; prefix: string } {
	const slash = pattern.indexOf('/');
	const host = slash === -1 ? pattern : pattern.slice(0, slash);
	const path = slash === -1 ? '/*' : pattern.slice(slash);
	return { host, prefix: path.split('*')[0] ?? '' };
}

// conservative: two patterns overlap when their hosts can match and one path prefix covers the other
function overlaps(ours: string, theirs: string): boolean {
	const a = splitPattern(ours);
	const b = splitPattern(theirs);
	if (!globToRegExp(b.host).test(a.host)) return false;
	return a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
}

export function checkRoute(hostname: string, script: string, existing: readonly AccountRoute[]) {
	if (hostname.includes('*') || hostname.includes('/')) throw new WildcardRouteError(hostname);
	const pattern = routePattern(hostname);
	for (const route of existing) {
		if (route.script === script) continue;
		if (overlaps(pattern, route.pattern)) throw new RouteShadowError(pattern, route);
	}
}

export async function attachRoute(
	deps: Guarded,
	claim: Claim,
	route: { zoneId: string; hostname: string }
): Promise<LedgerRow> {
	const { cloudflare, ledger, now } = deps;
	const script = scriptName(claim.siteId);
	const pattern = routePattern(route.hostname);
	const binding = `route:${route.hostname}`;
	let row = rowOf(await ledger.live(claim.siteId), binding);
	if (row !== undefined && row.providerId !== null) {
		if (row.missingAt !== null) throw new ResourceMissingError(row);
		return row;
	}
	if (row !== undefined && row.createdByOperation !== claim.operationId) {
		throw new ForeignResourceError('route', pattern, 'other_operation');
	}
	const existing = await cloudflare.listRoutes(route.zoneId);
	checkRoute(route.hostname, script, existing);
	const same = existing.find((candidate) => candidate.pattern === pattern);
	if (row === undefined) {
		if (same !== undefined) throw new ForeignResourceError('route', pattern, 'no_intent');
		row = (await ledger.intend({ ...claim, kind: 'route', binding, name: pattern }, now())).row;
	}
	const routeId =
		same?.id ?? (await cloudflare.addRoute(route.zoneId, pattern, script)).providerId;
	const providerId = routeRef(route.zoneId, routeId);
	await ledger.fill(row.id, providerId);
	return { ...row, providerId };
}

// #endregion

// #region undoing it

// only what this operation recorded, or what its own intent proves it made; a thing that was never
// ours, or that someone changed, is left in place
export async function rollbackRow(
	deps: Guarded,
	claim: Claim,
	match: (row: LedgerRow) => boolean
): Promise<void> {
	const { cloudflare, ledger, now } = deps;
	const row = (await ledger.live(claim.siteId)).find(match);
	if (row === undefined || row.createdByOperation !== claim.operationId) return;
	let providerId = row.providerId;
	if (providerId === null) {
		const found = await lookup(cloudflare, row);
		if (found === null) {
			await ledger.markDeleted(row.id, now());
			return;
		}
		providerId = found;
		await ledger.fill(row.id, providerId);
	}
	if (row.missingAt !== null) {
		await ledger.markDeleted(row.id, now());
		return;
	}
	await ownedDelete(deps, claim.plane, {
		siteId: claim.siteId,
		accountId: claim.accountId,
		kind: row.kind,
		id: providerId
	});
	await ledger.markDeleted(row.id, now());
}

// finishes an intent whose create was interrupted; the id is read, never used as a delete target
async function lookup(cloudflare: Cloudflare, row: LedgerRow): Promise<string | null> {
	if (row.kind === 'script') {
		const info = await cloudflare.getScript(row.name);
		return info !== null && info.tags.includes(siteTag(row.siteId)) ? row.name : null;
	}
	if (row.kind === 'route') return null;
	return (await cloudflare.findResource(row.kind, row.name))?.providerId ?? null;
}

// purge: what the ledger names, newest first, and nothing else
export async function purgeRows(
	deps: Guarded,
	claim: Omit<Claim, 'operationId'>,
	kinds: readonly OwnedKind[]
): Promise<void> {
	const { ledger, now } = deps;
	const rows = (await ledger.live(claim.siteId)).filter((row) => kinds.includes(row.kind));
	for (const row of [...rows].reverse()) {
		if (row.providerId === null) throw new IntentUnresolvedError(row);
		if (row.missingAt === null) {
			await ownedDelete(deps, claim.plane, {
				siteId: claim.siteId,
				accountId: claim.accountId,
				kind: row.kind,
				id: row.providerId
			});
		}
		await ledger.markDeleted(row.id, now());
	}
}

export async function purgeScript(deps: Guarded, claim: Omit<Claim, 'operationId'>): Promise<void> {
	const recorded = (await deps.ledger.live(claim.siteId)).some((row) => row.kind === 'script');
	if (recorded) return purgeRows(deps, claim, ['script']);
	// no row: only a managed site's own name in the dispatch namespace is safe to delete
	if (claim.plane !== 'managed') return;
	await ownedDelete(deps, claim.plane, {
		siteId: claim.siteId,
		accountId: claim.accountId,
		kind: 'script',
		id: scriptName(claim.siteId)
	});
}

// #endregion

// #region drift and leaks

export interface DriftReport {
	missing: LedgerRow[];
	changed: { row: LedgerRow; why: 'tag' | 'version' }[];
}

// reads the account and records what is gone; it never creates, changes or deletes anything there
export async function reconcileSite(
	deps: {
		cloudflare: Pick<Cloudflare, 'listResources' | 'getScript' | 'listRoutes'>;
		ledger: Pick<ResourceLedger, 'live' | 'markMissing'>;
		now(): number;
	},
	siteId: string
): Promise<DriftReport> {
	const report: DriftReport = { missing: [], changed: [] };
	const rows = (await deps.ledger.live(siteId)).filter(
		(row) => row.providerId !== null && row.missingAt === null
	);
	const listed = new Map<string, Set<string>>();
	const idsOf = async (key: string, read: () => Promise<{ id: string }[]>) => {
		let ids = listed.get(key);
		if (ids === undefined)
			listed.set(key, (ids = new Set((await read()).map((item) => item.id))));
		return ids;
	};
	for (const row of rows) {
		const id = row.providerId!;
		let present: boolean;
		if (row.kind === 'script') {
			const info = await deps.cloudflare.getScript(id);
			present = info !== null;
			if (info !== null) {
				if (!info.tags.includes(siteTag(siteId))) report.changed.push({ row, why: 'tag' });
				else if (row.fingerprint !== null && info.version !== row.fingerprint) {
					report.changed.push({ row, why: 'version' });
				}
			}
		} else if (row.kind === 'route') {
			const [zoneId, routeId] = splitRoute(id);
			present = (
				await idsOf(`route:${zoneId}`, () => deps.cloudflare.listRoutes(zoneId))
			).has(routeId);
		} else {
			const kind = row.kind;
			present = (await idsOf(kind, () => deps.cloudflare.listResources(kind))).has(id);
		}
		if (!present) {
			await deps.ledger.markMissing(row.id, deps.now());
			report.missing.push(row);
		}
	}
	return report;
}

export interface Leak {
	kind: ResourceKind;
	id: string;
	name: string;
}

export interface LeakReport {
	accountId: string;
	plane: SitePlane;
	leaks: Leak[];
	pending: { siteId: string; kind: OwnedKind; name: string }[];
	// managed only, and only a proposal for an operator to approve
	proposedDeletes: Leak[];
}

function ourNames(kind: ResourceKind): RegExp {
	const suffixes = RESOURCE_SPECS.filter((spec) => spec.kind === kind)
		.map((spec) => spec.suffix)
		.sort((a, b) => b.length - a.length);
	return new RegExp(`^s-[0-9a-z]{8,40}-(${suffixes.join('|')})$`);
}

// typed so it cannot reach a write method: it lists, compares and reports
export async function sweepLeaks(
	cloudflare: Pick<Cloudflare, 'listResources'>,
	ledger: Pick<ResourceLedger, 'account'>,
	scope: { accountId: string; plane: SitePlane }
): Promise<LeakReport> {
	const rows = await ledger.account(scope.accountId);
	const report: LeakReport = {
		accountId: scope.accountId,
		plane: scope.plane,
		leaks: [],
		pending: rows
			.filter((row) => row.providerId === null)
			.map((row) => ({ siteId: row.siteId, kind: row.kind, name: row.name })),
		proposedDeletes: []
	};
	const kinds: ResourceKind[] = ['kv', 'r2', 'd1'];
	for (const kind of kinds) {
		const recorded = new Set(
			rows.filter((row) => row.kind === kind).map((row) => row.providerId)
		);
		const intended = new Set(
			rows
				.filter((row) => row.kind === kind && row.providerId === null)
				.map((row) => row.name)
		);
		const pattern = ourNames(kind);
		for (const item of await cloudflare.listResources(kind)) {
			if (!pattern.test(item.name) || recorded.has(item.id) || intended.has(item.name))
				continue;
			report.leaks.push({ kind, id: item.id, name: item.name });
		}
	}
	if (scope.plane === 'managed') report.proposedDeletes = [...report.leaks];
	return report;
}

// #endregion
