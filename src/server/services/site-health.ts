import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { CATALOGUE, type CatalogueRow } from '../../shared/health/catalogue';
import type {
	HealthLeafView,
	HealthNodeView,
	ReadinessView,
	SiteHealth
} from '../../shared/health/view';
import {
	HEALTH_LEVELS,
	QUARANTINE_STRIKES,
	RUNGS,
	SEVERITY_LEVELS,
	type AutomationLevel,
	type RepairClass
} from '../../shared/health/vocab';
import { listBackups } from '../db/repos/backups';
import { getReadySite, type SiteRecord } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import {
	appendHistory,
	buildHealthTree,
	worse,
	type HealthLevel,
	type HealthNode,
	type HealthTreeInput,
	type HistoryEvent
} from '../domain/health-tree';
import {
	CHECK_LABELS,
	readiness,
	readinessChecks,
	type ReadinessObservations
} from '../domain/readiness';
import { checkUrl, UrlGuardError, type FetchLike } from '../integrations/url-guard';
import { principalActor, withOwnerToken, type CustodyDeps } from './owner-tokens';

export interface SiteHealthServices {
	getDb: () => Promise<CollegeDBClient>;
	custody: () => Promise<CustodyDeps>;
	fetch: FetchLike;
	now: () => number;
	timeoutMs: number;
}

export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_CACHE_MS = 15_000;
const MAX_CACHED_SITES = 1_000;
const MAX_BODY_CHARS = 1_000_000;
const BACKUPS_CHECKED = 50;

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): SiteHealthServices {
	return {
		getDb: notBuilt('The site store'),
		custody: notBuilt('Secret custody'),
		fetch: (input, init) => fetch(input, init),
		now: () => Date.now(),
		timeoutMs: HEALTH_TIMEOUT_MS
	};
}

let installed = productionServices();

export function setSiteHealthServices(over: Partial<SiteHealthServices>): void {
	installed = { ...installed, ...over };
}

export function resetSiteHealthServices(): void {
	installed = productionServices();
	cache.clear();
}

export function siteHealthServices(): SiteHealthServices {
	return installed;
}

// #region the worker's answer

// the shape of GET /health on a site; each field is read from do/routes/lifecycle.ts health()
const findingSchema = z.object({
	code: z.string(),
	severity: z.enum(SEVERITY_LEVELS),
	scope: z.string(),
	context: z.string()
});

const treeNodeSchema = z.object({
	id: z.string(),
	state: z.string(),
	title: z.string(),
	detail: z.string(),
	children: z.array(
		z.object({ id: z.string(), state: z.string(), title: z.string(), detail: z.string() })
	)
});

const workerHealthSchema = z.object({
	tree: z.object({ level: z.enum(HEALTH_LEVELS), nodes: z.array(treeNodeSchema) }),
	repair: z.object({
		rung: z.enum(RUNGS),
		code: z.string().nullable(),
		strikes: z.number()
	}),
	lastFindings: z.array(findingSchema),
	import: z
		.object({
			state: z.enum(['pending', 'applied', 'failed']),
			chunk: z.number(),
			chunks: z.number()
		})
		.nullish(),
	ledger: z
		.array(
			z.object({
				ts: z.number(),
				code: z.string(),
				severity: z.union([z.number(), z.string()]),
				action: z.string()
			})
		)
		.default([])
});

type WorkerHealth = z.infer<typeof workerHealthSchema>;

type Probe =
	| { kind: 'answer'; health: WorkerHealth }
	| { kind: 'starting'; step: string }
	| { kind: 'down'; reason: string }
	| { kind: 'unreadable'; reason: string };

const UNREADABLE_TOKEN =
	'The site did not accept the access the dashboard holds for it, so its health cannot be read.';

function migrateStep(header: string): string {
	const part = /^(\d+)\/(\d+)$/.exec(header);
	return part
		? `Unpacking the database, part ${part[1]} of ${part[2]}`
		: 'Unpacking the database';
}

// the answer is read here and nowhere else, so the token never leaves this function
async function classify(res: Response, token: string): Promise<Probe> {
	const { status } = res;
	if (status !== 200) void res.body?.cancel().catch(() => undefined);
	if (status === 503) {
		const migrate = res.headers.get('x-cfw-migrate');
		if (migrate !== null) return { kind: 'starting', step: migrateStep(migrate) };
		if (res.headers.has('x-cfw-object-reset')) {
			return { kind: 'starting', step: 'The site is restarting' };
		}
		return { kind: 'down', reason: 'The site answered that it is unavailable.' };
	}
	if (status === 401 || status === 403) return { kind: 'unreadable', reason: UNREADABLE_TOKEN };
	if (status >= 300 && status < 400) {
		return { kind: 'unreadable', reason: 'The site answered the health read with a redirect.' };
	}
	if (status >= 500) {
		return { kind: 'down', reason: `The site answered with an error (${status}).` };
	}
	if (status !== 200) {
		return { kind: 'unreadable', reason: `The site answered ${status} to the health read.` };
	}
	const unreadable = {
		kind: 'unreadable',
		reason: 'The site answered in a form the dashboard could not read.'
	} as const;
	let text: string;
	try {
		text = await res.text();
	} catch {
		return { kind: 'down', reason: 'The site stopped answering partway through.' };
	}
	if (text.length > MAX_BODY_CHARS) return unreadable;
	let body: unknown;
	try {
		body = JSON.parse(text.split(token).join('[removed]'));
	} catch {
		return unreadable;
	}
	const parsed = workerHealthSchema.safeParse(body);
	return parsed.success ? { kind: 'answer', health: parsed.data } : unreadable;
}

async function probe(
	services: SiteHealthServices,
	site: SiteRecord,
	principal: Principal
): Promise<Probe> {
	if (site.state !== 'active') {
		return { kind: 'down', reason: 'This site is not active, so its health is not read.' };
	}
	if (site.primaryHostname === null) {
		return { kind: 'down', reason: 'This site has no hostname yet.' };
	}
	let url: URL;
	try {
		url = new URL('/health', checkUrl(`https://${site.primaryHostname}`));
	} catch (error) {
		if (!(error instanceof UrlGuardError)) throw error;
		return { kind: 'down', reason: 'The hostname of this site is not valid.' };
	}
	try {
		return await withOwnerToken(
			await services.custody(),
			{ siteId: site.id, actor: principalActor(principal), operation: 'health.read' },
			async (token) => {
				let res: Response;
				try {
					res = await services.fetch(url.href, {
						method: 'GET',
						headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
						// a redirect would carry the token to another host
						redirect: 'manual',
						signal: AbortSignal.timeout(services.timeoutMs)
					});
				} catch {
					return { kind: 'down', reason: 'The site did not answer.' } as const;
				}
				return classify(res, token);
			}
		);
	} catch (error) {
		if (error instanceof ApiError && error.code === 'not_found') {
			return {
				kind: 'unreadable',
				reason: 'The dashboard holds no access for this site, so its health cannot be read.'
			};
		}
		throw error;
	}
}

// #endregion

// #region words

const AUTOMATION_WORDS: Record<AutomationLevel, string> = {
	auto: 'The site repairs this on its own.',
	'auto-with-guard': 'The site repairs this on its own once it is safe to.',
	approval: 'A repair exists, and it runs only after an owner approves it.',
	manual: 'This needs a person to fix it.'
};

const CLASS_WORDS: Record<RepairClass, string> = {
	safe: 'The repair does not touch stored data.',
	rebuild: 'The repair rebuilds cached or temporary pieces and keeps stored data.',
	stateful: 'The repair changes stored data, so it is handled with extra care.'
};

const NO_REPAIR = 'No repair is catalogued for this, so a person needs to look at it.';

function repairWords(rung: string, strikes: number): string {
	if (rung === 'quarantine') {
		return 'The site stopped accepting changes after repeated failures. It stays that way until a person releases it.';
	}
	if (rung === 'rollback') return 'The site is going back to its last restore point.';
	if (rung === 'observe') {
		return `The site is retrying. After ${QUARANTINE_STRIKES} failures in a row on the same problem it stops accepting changes.`;
	}
	return `The site is working through its repair steps (${strikes} so far).`;
}

function rowOf(node: HealthNode): CatalogueRow | undefined {
	if (node.source === 'supervisor') return CATALOGUE.get(node.id.slice('supervisor.'.length));
	if (node.source === 'reconcile') return CATALOGUE.get('pack.generation_mismatch');
	return undefined;
}

function guidanceOf(node: HealthNode, repair: WorkerHealth['repair']): HealthNodeView['guidance'] {
	if (node.level === 'ok' || node.children.length > 0) return null;
	const row = rowOf(node);
	const diagnostics = [
		{ label: 'Node', value: node.id },
		{ label: 'Source', value: node.source },
		{ label: 'State', value: node.state },
		{ label: 'Repair handle', value: row?.handle ?? node.handle ?? 'none' },
		...(row === undefined
			? []
			: [
					{ label: 'Repair class', value: row.class },
					{ label: 'Automation', value: row.automation },
					{ label: 'Preconditions', value: row.preconditions.join(', ') || 'none' },
					{ label: 'Escalation', value: row.escalation }
				])
	];
	const text =
		node.source === 'repair'
			? repairWords(repair.rung, repair.strikes)
			: row === undefined
				? NO_REPAIR
				: `${AUTOMATION_WORDS[row.automation]} ${CLASS_WORDS[row.class]}`;
	return { text, diagnostics };
}

function leafOf(node: HealthNode, repair: WorkerHealth['repair']): HealthLeafView {
	return {
		id: node.id,
		source: node.source,
		level: node.level,
		state: node.state,
		title: node.title,
		detail: node.detail,
		handle: node.handle,
		history: node.history,
		guidance: guidanceOf(node, repair),
		children: []
	};
}

// the domain builds a chain and its children only, so nothing deeper is lost
function viewOf(node: HealthNode, repair: WorkerHealth['repair']): HealthNodeView {
	return {
		...leafOf(node, repair),
		children: node.children.map((child) => leafOf(child, repair))
	};
}

// #endregion

// #region the tree

const SEVERITY_NAMES: readonly string[] = SEVERITY_LEVELS;

// the ledger comes newest first with the severity as a number; a state is kept only when it changes
function historyOf(ledger: WorkerHealth['ledger']): Record<string, readonly HistoryEvent[]> {
	let history: Record<string, readonly HistoryEvent[]> = {};
	for (const row of [...ledger].reverse()) {
		const severity =
			typeof row.severity === 'number' ? SEVERITY_NAMES[row.severity] : row.severity;
		history = appendHistory(history, `supervisor.${row.code}`, severity ?? 'unknown', row.ts);
		if (row.action !== '') history = appendHistory(history, 'repair', row.action, row.ts);
	}
	return history;
}

// the reconcile chain reaches the dashboard only as tree nodes, so its version comes from the detail line
function reconcileOf(tree: WorkerHealth['tree']): HealthTreeInput['reconcile'] {
	const chain = tree.nodes.find((node) => node.id === 'reconcile');
	const version = /^version (\d+) of (\d+)$/.exec(chain?.detail ?? '');
	if (chain === undefined || version === null) return undefined;
	return {
		version: Number(version[1]),
		packVersion: Number(version[2]),
		steps: chain.children.map((step) => ({
			id: step.id.replace(/^reconcile\./, ''),
			state: step.state,
			describe: step.title,
			detail: step.detail
		}))
	};
}

function treeOf(health: WorkerHealth): { level: HealthLevel; nodes: HealthNodeView[] } {
	const built = buildHealthTree({
		findings: health.lastFindings,
		reconcile: reconcileOf(health.tree),
		repair: health.repair,
		history: historyOf(health.ledger)
	});
	return {
		// the site's own level wins when the dashboard could not rebuild a node from its answer
		level: worse(built.level, health.tree.level),
		nodes: built.nodes.map((node) => viewOf(node, health.repair))
	};
}

// #endregion

// #region readiness

// nothing else is observed yet: no domain, alert or contact feature exists to ask
function readinessOf(responds: boolean, backup: boolean | null): ReadinessView {
	const observations: ReadinessObservations = {
		siteResponds: responds,
		adminAccessVerified: false,
		backupRestoredInTest: backup === true,
		intendedUseNeedsDomain: true,
		customDomainVerified: false,
		httpsVerified: false,
		criticalAlertConfigured: false,
		testNotificationDelivered: false,
		contacts: { technical: false, billing: false, recovery: false }
	};
	const observed = new Set<string>([CHECK_LABELS.responds]);
	if (backup !== null) observed.add(CHECK_LABELS.backup);
	const { level, missing } = readiness(observations);
	return {
		level,
		missing,
		checks: readinessChecks(observations).map(({ label, tier, holds }) => ({
			label,
			tier,
			state: !observed.has(label) ? 'not-checked' : holds ? 'done' : 'open'
		}))
	};
}

// null means the backups could not be read, which leaves the check not checked
async function hasVerifiedBackup(
	services: SiteHealthServices,
	orgId: string,
	siteId: string
): Promise<boolean | null> {
	try {
		const rows = await listBackups(await services.getDb(), orgId, siteId, {
			count: BACKUPS_CHECKED
		});
		return rows.some((row) => row.verified);
	} catch {
		return null;
	}
}

// #endregion

async function observe(
	services: SiteHealthServices,
	site: SiteRecord,
	principal: Principal
): Promise<SiteHealth> {
	const result = await probe(services, site, principal);
	const observedAt = new Date(services.now()).toISOString();
	const backup = await hasVerifiedBackup(services, site.organizationId, site.id);
	const base = { observedAt, reason: null, step: null, nodes: [] };

	if (result.kind === 'down') {
		return {
			...base,
			status: 'unreachable',
			level: 'error',
			reachable: false,
			reason: result.reason,
			readiness: readinessOf(false, backup)
		};
	}
	if (result.kind === 'unreadable') {
		return {
			...base,
			status: 'unreadable',
			level: 'warn',
			reachable: true,
			reason: result.reason,
			readiness: readinessOf(false, backup)
		};
	}
	if (result.kind === 'starting') {
		return {
			...base,
			status: 'starting',
			level: 'info',
			reachable: true,
			step: result.step,
			readiness: readinessOf(false, backup)
		};
	}

	const { health } = result;
	const tree = treeOf(health);
	const restore = health.import?.state === 'pending' ? health.import : null;
	const level = restore ? worse(tree.level, 'info') : tree.level;
	const problem = HEALTH_LEVELS.indexOf(level) > HEALTH_LEVELS.indexOf('info');
	return {
		...base,
		status: restore ? 'starting' : problem ? 'attention' : 'healthy',
		level,
		reachable: true,
		step: restore ? `Restoring a database, part ${restore.chunk} of ${restore.chunks}` : null,
		nodes: tree.nodes,
		readiness: readinessOf(restore === null, backup)
	};
}

// #region cache

// one read per site per window; the promise is kept so a burst of callers shares one request
const cache = new Map<string, { at: number; read: Promise<SiteHealth> }>();

export function resetSiteHealthCache(): void {
	cache.clear();
}

export async function readSiteHealth(
	services: SiteHealthServices,
	input: { orgId: string; siteId: string; principal: Principal }
): Promise<SiteHealth> {
	const site = await getReadySite(await services.getDb(), input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const now = services.now();
	const hit = cache.get(site.id);
	if (hit !== undefined && now - hit.at < HEALTH_CACHE_MS) return hit.read;

	const read = observe(services, site, input.principal);
	cache.set(site.id, { at: now, read });
	if (cache.size > MAX_CACHED_SITES) {
		for (const [id, entry] of cache) {
			if (now - entry.at >= HEALTH_CACHE_MS || cache.size > MAX_CACHED_SITES)
				cache.delete(id);
		}
	}
	// a failed read is not kept, so the next call asks again
	read.catch(() => {
		if (cache.get(site.id)?.read === read) cache.delete(site.id);
	});
	return read;
}

// #endregion
