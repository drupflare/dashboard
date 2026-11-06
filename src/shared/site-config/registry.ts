import { CONFIG_GROUPS } from '../permissions';

export type SettingPermission = (typeof CONFIG_GROUPS)[number];

// mirrors KV_OVERRIDABLE in the worker (src/ops/plan.ts); a drift test compares the two lists
export const KV_OVERRIDABLE_NAMES = [
	'RENDER_BUDGET_MS',
	'FILL_BATCH_SIZE',
	'HTTP_DRAIN_LIMIT',
	'MIRROR_LIMIT',
	'LAZY_FS_BUDGET_BYTES',
	'PREFILL',
	'GEN_BUCKET_MS',
	'MAIL_TRANSPORT',
	'MAIL_DRAIN_LIMIT',
	'SHELL_ASSEMBLY',
	'OPCACHE_MODE',
	'ARGON2',
	'SITE_LOCATION_HINT',
	'REPLICA_COUNT',
	'REPLICA_LAG_MS',
	'SITE_WARM',
	'WARM_INTERVAL_MS',
	'WARM_CEILING_MS',
	'KEEP_WARM_MS',
	'IDLE_CEILING_MS',
	'SLEEP_BUDGET_MS',
	'EDGE_PLAN',
	'ASSET_AGGREGATES',
	'MEMORY_CACHE_BINS',
	'MEMORY_CACHE_MAX_ITEMS',
	'RESPONSE_HEADERS',
	'REDIRECTS',
	'CSP_MODE',
	'SPOOL',
	'SPOOL_IMAGES',
	'SPOOL_VIDEO',
	'SPOOL_EMBEDS'
] as const;

// mirrors OWNER_ONLY_LEVERS in the worker; a drift test compares the two lists
export const OWNER_ONLY_NAMES = [
	'CSP_MODE',
	'SPOOL',
	'SPOOL_IMAGES',
	'SPOOL_VIDEO',
	'SPOOL_EMBEDS'
] as const;

export type LeverMark = { value: number; label: string; note: string };

export type LeverDomain =
	| {
			kind: 'int';
			min: number;
			max?: number;
			unit?: 'ms' | 'bytes' | 'seconds';
			default?: number;
			marks?: readonly LeverMark[];
	  }
	| { kind: 'flag'; default?: '0' | '1' }
	| { kind: 'enum'; values: readonly string[]; default?: string }
	| { kind: 'text' }
	| { kind: 'bins' }
	| { kind: 'rules' };

export type RegistryEntry = {
	label: string;
	// kv is an owner override; var is a deploy-time variable, read-only here
	layer: 'kv' | 'var';
	permission: SettingPermission;
	domain: LeverDomain;
	danger?: boolean;
	widget?: 'lever-slider' | 'json';
	note?: string;
};

const WARM_INTERVAL_MARKS: readonly LeverMark[] = [
	{ value: 8000, label: 'Default and fastest', note: '10,800 wakes a day.' },
	{ value: 30000, label: 'Middle', note: '2,880 wakes a day.' },
	{ value: 600000, label: 'Least energy', note: '144 wakes a day.' }
];

const WARM_CEILING_MARKS: readonly LeverMark[] = [
	{ value: 9500, label: 'Default and fastest', note: 'The object stays resident.' },
	{ value: 30000, label: 'Middle', note: 'Each site may climb to 30 s.' },
	{ value: 120000, label: 'Least energy', note: 'Each site may climb to 120 s.' }
];

const SITE_LOCATION_HINTS = [
	'wnam',
	'enam',
	'sam',
	'weur',
	'eeur',
	'apac',
	'apac-ne',
	'apac-se',
	'oc',
	'afr',
	'me'
] as const;

export const SITE_CONFIG_REGISTRY: Record<string, RegistryEntry> = {
	SPOOL: {
		label: 'Spool',
		layer: 'kv',
		permission: 'security',
		domain: { kind: 'flag' },
		note: 'On for a paid site and off for a free one. 0 turns it off.'
	},
	SPOOL_IMAGES: {
		label: 'Spool images',
		layer: 'kv',
		permission: 'security',
		domain: { kind: 'flag', default: '1' },
		note: '0 turns it off.'
	},
	SPOOL_VIDEO: {
		label: 'Spool video',
		layer: 'kv',
		permission: 'security',
		domain: { kind: 'flag', default: '1' },
		note: '0 turns it off.'
	},
	SPOOL_EMBEDS: {
		label: 'Spool embeds',
		layer: 'kv',
		permission: 'security',
		domain: { kind: 'flag', default: '1' },
		note: '0 turns it off.'
	},
	WARM_INTERVAL_MS: {
		label: 'Warm interval',
		layer: 'kv',
		permission: 'runtime',
		domain: {
			kind: 'int',
			min: 8000,
			max: 600000,
			unit: 'ms',
			default: 8000,
			marks: WARM_INTERVAL_MARKS
		},
		widget: 'lever-slider'
	},
	WARM_CEILING_MS: {
		label: 'Warm ceiling',
		layer: 'kv',
		permission: 'runtime',
		domain: {
			kind: 'int',
			min: 9500,
			max: 120000,
			unit: 'ms',
			default: 9500,
			marks: WARM_CEILING_MARKS
		},
		widget: 'lever-slider',
		note: 'Trial. The neighbour-effect test has not run, so a site may retreat at once.'
	},
	REPLICA_COUNT: {
		label: 'Replica count',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'int', min: 0, max: 256, default: 0 },
		note: 'A floor. Autoscaling can add lanes above it.'
	},
	REPLICA_AUTOSCALE: {
		label: 'Replica autoscale',
		layer: 'var',
		permission: 'runtime',
		domain: { kind: 'flag', default: '1' },
		note: '0 pins the lane count to REPLICA_COUNT.'
	},
	REPLICA_LAG_MS: {
		label: 'Replica lag',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'int', min: 1000, max: 300000, unit: 'ms', default: 30000 },
		note: 'How far a read lane may trail the primary.'
	},
	WRITE_FORWARD: {
		label: 'Write forwarding',
		layer: 'var',
		permission: 'runtime',
		domain: { kind: 'flag', default: '1' },
		note: '0 turns it off.'
	},
	PAGE_KV_ENABLED: {
		label: 'Page KV tier',
		layer: 'var',
		permission: 'runtime',
		domain: { kind: 'flag' },
		note: 'Needs the PAGE_KV binding. 1 forces the tier on and 0 forces it off.'
	},
	PAGE_KV_TTL: {
		label: 'Page KV lifetime',
		layer: 'var',
		permission: 'runtime',
		domain: { kind: 'int', min: 60, unit: 'seconds', default: 86400 },
		note: 'Values below 60 are raised to 60.'
	},
	NEVER_STALE: {
		label: 'Never stale paths',
		layer: 'var',
		permission: 'runtime',
		domain: { kind: 'text' },
		note: 'Comma-separated path prefixes never served from a previous generation.'
	},
	CSP_MODE: {
		label: 'Content Security Policy',
		layer: 'kv',
		permission: 'security',
		domain: { kind: 'enum', values: ['off', 'report-only', 'enforce'] },
		danger: true,
		note: 'Defaults to report-only on a paid site and off on a free one.'
	},
	RESPONSE_HEADERS: {
		label: 'Response headers',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'rules' },
		widget: 'json'
	},
	REDIRECTS: {
		label: 'Redirects',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'rules' },
		widget: 'json'
	},
	EDGE_PLAN: {
		label: 'Edge plan',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'flag', default: '1' },
		note: '0 turns it off, which costs one object hop per page.'
	},
	ASSET_AGGREGATES: {
		label: 'Asset aggregates',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'flag', default: '0' },
		note: 'Only 1 turns it on.'
	},
	SITE_LOCATION_HINT: {
		label: 'Location hint',
		layer: 'kv',
		permission: 'runtime',
		domain: { kind: 'enum', values: SITE_LOCATION_HINTS },
		note: 'Where the site object is created. Unset leaves placement to the first request.'
	},
	PHP_LOG_LEVEL: {
		label: 'PHP log level',
		layer: 'var',
		permission: 'runtime',
		domain: {
			kind: 'enum',
			values: ['off', 'error', 'warn', 'warning', 'log', 'notice', 'info', 'debug', 'all'],
			default: 'info'
		},
		note: 'The most severe PHP log level sent to the Worker log.'
	},
	MAX_UPLOAD_BYTES: {
		label: 'Upload limit',
		layer: 'var',
		permission: 'content',
		domain: { kind: 'int', min: 0, unit: 'bytes', default: 104857600 },
		note: '0 disables the limit.'
	}
};

export function isKvWritable(name: string): boolean {
	return (KV_OVERRIDABLE_NAMES as readonly string[]).includes(name);
}

export function isOwnerOnly(name: string): boolean {
	return (OWNER_ONLY_NAMES as readonly string[]).includes(name);
}
