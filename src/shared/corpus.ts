import { z } from 'zod';
import { corpusTitle } from './corpus-titles';

const states = ['inline', 'parked', 'degraded', 'unsupported', 'unknown'] as const;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const cell = z.object({ state: z.enum(states), note: z.string().optional() });
const rowSet = z.record(z.string(), cell);

const deployed = z.object({
	sha,
	run: z.string(),
	date: z.string(),
	plan: z.string().optional(),
	rows: rowSet
});

const repo = z.object({
	sha,
	lane: z.string(),
	run: z.string(),
	date: z.string(),
	rows: rowSet,
	deployed: deployed.optional()
});

export const corpusSchema = z
	.object({
		rows: z.array(z.string()).length(13),
		repos: z.record(z.string(), repo)
	})
	.superRefine((manifest, ctx) => {
		const capabilities = [...manifest.rows].sort().join('\n');
		for (const [name, entry] of Object.entries(manifest.repos)) {
			const blocks = entry.deployed ? [entry.rows, entry.deployed.rows] : [entry.rows];
			for (const rows of blocks) {
				if (Object.keys(rows).sort().join('\n') === capabilities) continue;
				ctx.addIssue({
					code: 'custom',
					path: ['repos', name, 'rows'],
					message: 'capability cells do not match the manifest rows'
				});
			}
		}
	});

export const corpusSourcesSchema = z.record(
	z.string(),
	z.object({
		repo: z.string().url(),
		shape: z.string(),
		core: z.string(),
		legacy: z.object({ sha, date: z.string(), rows: rowSet }).nullable()
	})
);

export type CorpusSources = z.infer<typeof corpusSourcesSchema>;
export type CorpusManifest = z.infer<typeof corpusSchema>;
type CorpusRepo = CorpusManifest['repos'][string];
type CorpusCell = z.infer<typeof cell>;

export const corpusStatuses = [
	'deployed',
	'verified',
	'partial',
	'needs upgrade',
	'unsupported'
] as const;

export type CorpusStatus = (typeof corpusStatuses)[number];

export const CORPUS_STATUS_LABELS: Record<CorpusStatus, string> = {
	deployed: 'Deployed',
	verified: 'Verified',
	partial: 'Partial',
	'needs upgrade': 'Needs Upgrade',
	unsupported: 'Unsupported'
};

export class CorpusInvalidError extends Error {}

export function parseCorpusManifest(text: string): CorpusManifest {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		throw new CorpusInvalidError(`manifest is not JSON: ${(err as Error).message}`);
	}
	const result = corpusSchema.safeParse(json);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
		throw new CorpusInvalidError(issues.join('; '));
	}
	return result.data;
}

const passes = (cell: CorpusCell) => cell.state !== 'unsupported' && cell.state !== 'unknown';

// the manifest has no status field; these rules reproduce the status column in
// worker/docs/architecture/compatibility.md (3 deployed, 12 verified, 3 partial,
// 3 unsupported, 6 needs upgrade).
export function corpusStatus(repo: CorpusRepo): CorpusStatus {
	if (repo.deployed && Object.values(repo.deployed.rows).every(passes)) return 'deployed';
	const rows = Object.values(repo.rows);
	if (rows.every(passes)) return 'verified';
	if (rows.some(passes)) return 'partial';
	return repo.rows.install?.note?.startsWith('needs upgrade') ? 'needs upgrade' : 'unsupported';
}

export type CorpusEntry = { name: string; status: CorpusStatus; installNote?: string };

export function corpusEntries(manifest: CorpusManifest): CorpusEntry[] {
	return Object.entries(manifest.repos).map(([name, repo]) => ({
		name,
		status: corpusStatus(repo),
		installNote: repo.rows.install?.note
	}));
}

export type InstallDecision = { allowed: true } | { allowed: false; reason: string };

export function installDecision(entry: CorpusEntry): InstallDecision {
	if (entry.status === 'verified' || entry.status === 'deployed') return { allowed: true };
	if (entry.status === 'partial') {
		return { allowed: false, reason: `${entry.name} is partial in the corpus` };
	}
	return {
		allowed: false,
		reason: entry.installNote ?? `${entry.name} is ${entry.status} in the corpus`
	};
}

export type CorpusSearch = { q?: string; status?: CorpusStatus };

type RowSet = CorpusManifest['repos'][string]['rows'];

export const CORPUS_CHECK_LABELS: Record<string, string> = {
	install: 'Install',
	'container build': 'Build Step',
	'anon render': 'Public Pages',
	'auth render': 'Signed-In Pages',
	'entity crud': 'Content Records',
	'form submit': 'Form Submit',
	'file rw': 'File Read and Write',
	'queue cron': 'Queues and Cron',
	'outbound http': 'Outbound Requests',
	update: 'Updates',
	'cache rebuild': 'Cache Rebuild',
	'config import': 'Config Import',
	'module workflow': 'Module Steps'
};

export const checkLabel = (check: string): string => CORPUS_CHECK_LABELS[check] ?? check;

// a lane note is a log line with page markup and JSON in it; a reader gets one plain sentence
export function reasonOf(note = ''): string {
	const flat = note.replace(/\s+/g, ' ').trim();
	const core = /^needs upgrade: core (\S+) does not accept Drupal (\d+)/.exec(flat);
	if (core) return `Built for an older Drupal (${core[1]}). The platform runs Drupal ${core[2]}.`;
	const notSite = /^not a site: (.+)$/.exec(flat);
	if (notSite)
		return `Not a site. ${notSite[1]!.charAt(0).toUpperCase()}${notSite[1]!.slice(1)}.`;
	const refused = /^refused: (.+)$/.exec(flat);
	if (refused) return `${refused[1]!.charAt(0).toUpperCase()}${refused[1]!.slice(1)}.`;
	if (flat.startsWith('blocked by install')) return 'Held back because it did not install.';
	if (/^enabling .+ was refused/.test(flat)) return 'Drupal refused to turn the module on.';
	const failed = /^(\d+) failed:/.exec(flat);
	if (failed) return `${failed[1]} packages or modules did not install.`;
	if (/^the run halted/.test(flat)) return 'The update run stopped before it finished.';
	if (/^upload answered/.test(flat)) return 'A file upload did not save.';
	if (/^import answered/.test(flat)) return 'The configuration import showed an error.';
	if (/^the run answered|Cron run completed/.test(flat)) return 'Cron did not complete.';
	if (/answered 5\d\d/.test(flat)) return 'The page failed with a server error.';
	return 'It failed when we ran it.';
}

const SHAPE_LABELS: Record<string, string> = {
	module: 'Module',
	modules: 'Modules',
	suite: 'Module Suite',
	'composer-plugin': 'Composer Plugin',
	project: 'Full Site',
	profile: 'Install Profile'
};

export const shapeLabel = (shape: string | null): string | null =>
	shape === null ? null : (SHAPE_LABELS[shape] ?? null);

export function coreLabel(core: string | null): string | null {
	if (core === null || core === 'n/a') return null;
	const versions = core.split('||').map((part) => part.trim().replace(/^[\^~]/, ''));
	return `Drupal ${versions.join(' or ')}`;
}

export function checksSentence(item: Pick<CorpusResult, 'checks' | 'legacy' | 'status'>): string {
	const { passed, total, unchecked } = item.checks;
	if (item.status === 'needs upgrade' && item.legacy === null) {
		return 'Not run with the legacy layer yet';
	}
	const base = `${passed} of ${total} checks pass${item.legacy ? ' with the legacy layer' : ''}`;
	return unchecked > 0 ? `${base}, ${unchecked} not checked` : base;
}

export type Blocker = { checks: string[]; reason: string };

// the checks that did not pass, grouped by reason so a shared cause reads once
export function blockersOf(rows: RowSet): Blocker[] {
	const groups = new Map<string, string[]>();
	for (const [check, cell] of Object.entries(rows)) {
		if (passes(cell)) continue;
		const reason = reasonOf(cell.note);
		groups.set(reason, [...(groups.get(reason) ?? []), checkLabel(check)]);
	}
	return [...groups].map(([reason, checks]) => ({ reason, checks }));
}

export type CorpusChecks = { passed: number; total: number; unchecked: number };

const checksOf = (rows: RowSet): CorpusChecks => {
	const cells = Object.values(rows);
	return {
		passed: cells.filter(passes).length,
		total: cells.length,
		unchecked: cells.filter((cell) => cell.state === 'unknown').length
	};
};

export type CorpusResult = {
	id: string;
	// the key the manifest uses; kept for the API, never shown
	name: string;
	title: string;
	summary: string;
	repo: string | null;
	core: string | null;
	shape: string | null;
	status: CorpusStatus;
	install: InstallDecision;
	checks: CorpusChecks;
	blockers: Blocker[];
	// set when the codebase needs a newer Drupal and the status comes from its run with the legacy layer
	legacy: { date: string; baseOnly: boolean } | null;
	cells: RowSet;
};

const statusOfRows = (rows: RowSet): CorpusStatus => {
	const cells = Object.values(rows);
	if (cells.every(passes)) return 'verified';
	return cells.some(passes) ? 'partial' : 'needs upgrade';
};

export function searchCorpus(
	manifest: CorpusManifest,
	{ q = '', status }: CorpusSearch = {},
	sources: CorpusSources = {}
): CorpusResult[] {
	const needle = q.trim().toLowerCase();
	return Object.entries(manifest.repos).flatMap(([name, repo]) => {
		const source = sources[name];
		const { title, summary } = corpusTitle(name);
		let state = corpusStatus(repo);
		let rows = repo.rows;
		let legacy: CorpusResult['legacy'] = null;
		// a codebase that needs a newer Drupal is judged by its run with the legacy layer when one exists
		if (
			state === 'needs upgrade' &&
			source?.legacy &&
			Object.keys(source.legacy.rows).length > 0
		) {
			const ran = statusOfRows(source.legacy.rows);
			if (ran !== 'needs upgrade') {
				state = ran;
				rows = source.legacy.rows;
				legacy = {
					date: source.legacy.date,
					baseOnly: /\b0\/0 modules enabled/.test(source.legacy.rows.install?.note ?? '')
				};
			}
		}
		if (status && state !== status) return [];
		const haystack = [name, title, summary, source?.repo ?? ''].join(' ').toLowerCase();
		if (needle && !haystack.includes(needle)) return [];
		const install = installDecision({
			name: title,
			status: state,
			installNote: rows.install?.note
		});
		return [
			{
				id: name,
				name,
				title,
				summary,
				repo: source?.repo ?? null,
				core: source?.core ?? null,
				shape: source?.shape ?? null,
				status: state,
				install: install.allowed
					? install
					: {
							allowed: false,
							reason:
								state === 'partial'
									? `${title} passes some checks and fails others.`
									: reasonOf(rows.install?.note)
						},
				checks: checksOf(rows),
				blockers: state === 'verified' || state === 'deployed' ? [] : blockersOf(rows),
				legacy,
				cells: rows
			}
		];
	});
}
