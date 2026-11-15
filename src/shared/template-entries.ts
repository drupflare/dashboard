import corpus from './corpus.json';

export const TEMPLATE_ENTRY_IDS = ['thunder', 'govcms', 'farmos'] as const;
export type TemplateEntryId = (typeof TEMPLATE_ENTRY_IDS)[number];

export interface TemplateEntry {
	id: TemplateEntryId;
	name: string;
	summary: string;
	repo: string;
	profile: string;
	mode: 'template' | 'profile';
	template: string;
	package: string;
	extra: string[];
	auditOff: boolean;
	patchTolerant: boolean;
	enablePatching: boolean;
}

// repo, profile and install settings follow the worker corpus entries and the measured builds
export const TEMPLATE_ENTRIES: Record<TemplateEntryId, TemplateEntry> = {
	thunder: {
		id: 'thunder',
		name: 'Thunder',
		summary: 'A publishing distribution for news and magazine sites.',
		repo: 'https://github.com/thunder/thunder-distribution',
		profile: 'thunder',
		mode: 'template',
		template: 'thunder/thunder-project',
		package: 'thunder/thunder-distribution',
		extra: [],
		auditOff: false,
		patchTolerant: true,
		enablePatching: false
	},
	govcms: {
		id: 'govcms',
		name: 'GovCMS',
		summary: 'A distribution for government websites.',
		repo: 'https://github.com/govCMS/GovCMS',
		profile: 'govcms',
		mode: 'profile',
		template: 'drupal/recommended-project:11.4.5',
		package: 'govcms/govcms',
		extra: ['drush/drush'],
		auditOff: true,
		patchTolerant: false,
		enablePatching: true
	},
	farmos: {
		id: 'farmos',
		name: 'farmOS',
		summary: 'Farm management and record keeping.',
		repo: 'https://github.com/farmOS/farmOS',
		profile: 'farm',
		mode: 'template',
		template: 'farmos/project:4.x-dev',
		package: 'farmos/farmos',
		extra: [],
		auditOff: true,
		patchTolerant: false,
		enablePatching: false
	}
};

export const isTemplateEntryId = (id: string): id is TemplateEntryId =>
	(TEMPLATE_ENTRY_IDS as readonly string[]).includes(id);

// the commit is the corpus pin; "latest" is never offered
export function templateCommit(id: TemplateEntryId): string {
	const repo = (corpus.repos as Record<string, { sha: string }>)[id];
	if (repo === undefined) throw new Error(`the corpus has no entry ${id}`);
	return repo.sha;
}

export function templateSpec(id: TemplateEntryId) {
	const { name: _name, summary: _summary, ...entry } = TEMPLATE_ENTRIES[id];
	return { ...entry, sha: templateCommit(id) };
}

// Workers Free plan, Durable Objects pricing page: rows written per day. Unreviewed placeholder
// until the plan catalogue carries a row limit of its own.
export const FREE_DAILY_ROWS = 100_000;

export interface TemplateManifest {
	entryId: string;
	commit: string;
	phpVersion: string;
	buildSeconds: number;
	rows: number;
	advisories: { id: string; package: string }[] | null;
	patchesFailed: { package: string; patch: string }[];
	packages: number;
}

export interface TemplateFit {
	fits: boolean;
	rows: number;
	limit: number;
	// whole percent of the daily limit, rounded up so a near miss never reads as zero
	percent: number;
}

// the rows come from the build's own database dump, counted at build time
export function templateFit(rows: number, limit: number = FREE_DAILY_ROWS): TemplateFit {
	return {
		fits: rows <= limit,
		rows,
		limit,
		percent: Math.max(1, Math.ceil((rows / limit) * 100))
	};
}

// a new site gets only the database, so templates wait for code delivery
export const TEMPLATE_CODE_DELIVERY = false;

export const TEMPLATE_HELD_TITLE = 'Templates Need an Update';
export const TEMPLATE_HELD_REASON =
	'Starting a site from a template is paused. New sites cannot yet receive the code a template needs, so templates stay unavailable. A template build is kept and can be used once that changes.';

export const TEMPLATE_STATES = ['not_built', 'building', 'ready', 'failed'] as const;
export type TemplateState = (typeof TEMPLATE_STATES)[number];

export const TEMPLATE_STATE_LABELS: Record<TemplateState, string> = {
	not_built: 'Not built yet',
	building: 'Building',
	ready: 'Ready',
	failed: 'The last build failed'
};
