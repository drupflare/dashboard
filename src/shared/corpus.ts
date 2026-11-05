import { z } from 'zod';

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

export type CorpusManifest = z.infer<typeof corpusSchema>;
type CorpusRepo = CorpusManifest['repos'][string];
type CorpusCell = z.infer<typeof cell>;

export type CorpusStatus = 'deployed' | 'verified' | 'partial' | 'needs upgrade' | 'unsupported';

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

const passes = (cell: CorpusCell) => cell.state !== 'unsupported';

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
