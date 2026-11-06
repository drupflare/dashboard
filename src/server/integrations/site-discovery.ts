import {
	DISCOVERY_PATH,
	DISCOVERY_VERSION,
	type DiscoveryDocument,
	discoveryDocumentSchema
} from '@contracts/discovery';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
	isKvWritable,
	isOwnerOnly,
	type LeverDomain,
	type SettingPermission,
	SITE_CONFIG_REGISTRY
} from '../../shared/site-config/registry';
import type { FetchLike } from './url-guard';

type Settings = DiscoveryDocument['settings'];

export type DiscoveryRelease = { version: string; releaseId: string; schemaVersion: number };

export type DiscoverySite = {
	origin: string;
	ownerToken: string;
	siteId: string;
	release: DiscoveryRelease;
};

export class DiscoveryError extends Error {
	constructor(
		readonly code: 'malformed' | 'status' | 'unreachable',
		message: string
	) {
		super(message);
		this.name = 'DiscoveryError';
	}
}

export const DISCOVERY_TIMEOUT_MS = 5_000;

const leverDomainSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('int'),
		min: z.number(),
		max: z.number(),
		unit: z.enum(['ms', 'bytes']).optional(),
		default: z.number().optional(),
		marks: z
			.array(z.object({ value: z.number(), label: z.string(), note: z.string() }))
			.optional()
	}),
	z.object({ kind: z.literal('flag'), default: z.enum(['0', '1']).optional() }),
	z.object({
		kind: z.literal('enum'),
		values: z.array(z.string()),
		default: z.string().optional()
	}),
	z.object({ kind: z.literal('bins') }),
	z.object({ kind: z.literal('rules') })
]);

// the body of GET /settings (src/site/deployment.ts settingsRoute)
export const settingsResponseSchema = z.object({
	ok: z.literal(true),
	levers: z.array(
		z.object({
			name: z.string(),
			value: z.string().nullable(),
			source: z.enum(['kv', 'var', 'default']),
			domain: leverDomainSchema
		})
	)
});

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export type CapabilityInput = {
	id: string;
	expected: boolean;
	blocker: 'permanent' | 'platform' | 'scheduled' | 'by-design' | null;
};

export type ComposeInput = {
	settings: SettingsResponse;
	release: DiscoveryRelease;
	siteId: string;
	capabilities?: CapabilityInput[];
	limits?: Record<string, number>;
};

// src/do/limits.ts FILL_QUEUE_MAX; src/ops/edge-plan.ts EDGE_PLAN_ENTRIES and EDGE_PLAN_BYTES;
// src/ops/body-limit.ts DEFAULT_MAX_UPLOAD_BYTES
const DRUPAL_LIMITS = {
	fillQueueMax: 500,
	edgePlanEntries: 64,
	edgePlanBytes: 8388608,
	maxUploadBytes: 104857600
};

const HEALTH_VOCABULARY = ['ok', 'info', 'warn', 'error', 'critical'];

// src/site/routes.ts OWNER_ROUTES (auth) and src/site/deployment.ts (settings and deployment reads and writes)
const ROUTES = [
	{ id: 'settings.read', method: 'GET', path: '/settings', class: 'safe', auth: 'owner-token' },
	{
		id: 'settings.write',
		method: 'PUT',
		path: '/settings',
		class: 'stateful',
		auth: 'owner-token'
	},
	{ id: 'health.read', method: 'GET', path: '/health', class: 'safe', auth: 'owner-token' },
	{
		id: 'deployment.read',
		method: 'GET',
		path: '/deployment',
		class: 'safe',
		auth: 'owner-token'
	},
	{
		id: 'deployment.write',
		method: 'PUT',
		path: '/deployment',
		class: 'stateful',
		auth: 'owner-token'
	},
	{
		id: 'serve-stats.read',
		method: 'GET',
		path: '/serve-stats',
		class: 'safe',
		auth: 'owner-token'
	}
] as const;

// src/ui/admin/shell.ts ADMIN_PAGES and SURFACE_PREFIX; drupal-src/modules/custom/drupflare/drupflare.routing.yml
const REDIRECTS: readonly [from: string, to: string][] = [
	['/admin/config/drupflare', '/sites/{id}/config'],
	['/admin/config/drupflare/status', '/sites/{id}'],
	['/_cfw', '/sites/{id}/config'],
	['/_cfw/extend', '/sites/{id}/modules'],
	['/_cfw/commands', '/sites/{id}/repairs'],
	['/_cfw/operate', '/sites/{id}/repairs'],
	['/_cfw/deploy', '/sites/{id}/readiness'],
	['/_cfw/git', '/sites/{id}/git'],
	['/_cfw/access', '/sites/{id}/access']
];

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((k) => [k, canonical(record[k])])
		);
	}
	return value;
}

function settingsEtag(block: Omit<Settings, 'etag'>): string {
	const digest = createHash('sha256')
		.update(JSON.stringify(canonical(block)))
		.digest('hex');
	return `"${digest.slice(0, 32)}"`;
}

function domainSchema(domain: LeverDomain): Record<string, unknown> {
	switch (domain.kind) {
		case 'int':
			return {
				type: 'integer',
				minimum: domain.min,
				maximum: domain.max,
				...(domain.default !== undefined ? { default: domain.default } : {}),
				...(domain.unit !== undefined ? { 'x-unit': domain.unit } : {}),
				...(domain.marks !== undefined ? { 'x-marks': domain.marks } : {})
			};
		case 'flag':
			return {
				type: 'string',
				enum: ['0', '1'],
				...(domain.default !== undefined ? { default: domain.default } : {})
			};
		case 'enum':
			return {
				type: 'string',
				enum: [...domain.values],
				...(domain.default !== undefined ? { default: domain.default } : {})
			};
		case 'bins':
		case 'rules':
		case 'text':
			return { type: 'string' };
	}
}

function propertySchema(
	name: string,
	domain: LeverDomain,
	permission: SettingPermission,
	meta: (typeof SITE_CONFIG_REGISTRY)[string] | undefined
): Record<string, unknown> {
	const widget = meta?.widget ?? (domain.kind === 'rules' ? 'json' : undefined);
	return {
		...domainSchema(domain),
		title: meta?.label ?? name,
		...(meta?.note !== undefined ? { description: meta.note } : {}),
		'x-ui': {
			group: permission,
			permission,
			...(widget !== undefined ? { widget } : {}),
			...(meta?.danger ? { danger: true } : {})
		}
	};
}

function valueOf(lever: SettingsResponse['levers'][number]): unknown {
	if (lever.domain.kind === 'int' && lever.value !== null && /^-?\d+$/.test(lever.value.trim())) {
		return Number(lever.value);
	}
	return lever.value;
}

function capabilityOf(c: CapabilityInput) {
	if (c.expected) return { id: c.id, state: 'enabled' as const, reason: null };
	if (c.blocker === null)
		return { id: c.id, state: 'disabled' as const, reason: 'no blocker named' };
	if (c.blocker === 'by-design')
		return { id: c.id, state: 'disabled' as const, reason: c.blocker };
	return { id: c.id, state: 'unavailable' as const, reason: c.blocker };
}

// only names on the worker's override list are writable
export function composeDrupalDiscovery(input: ComposeInput): DiscoveryDocument {
	const schema: Settings['schema'] = {};
	const values: Settings['values'] = {};
	const provenance: Settings['provenance'] = {};
	const writable: Settings['writable'] = {};

	for (const lever of input.settings.levers) {
		const meta = SITE_CONFIG_REGISTRY[lever.name];
		const permission: SettingPermission = isOwnerOnly(lever.name)
			? 'security'
			: (meta?.permission ?? 'runtime');
		schema[lever.name] = propertySchema(lever.name, lever.domain, permission, meta);
		values[lever.name] = valueOf(lever);
		provenance[lever.name] = lever.source;
		if (isKvWritable(lever.name)) writable[lever.name] = 'kv';
	}

	const block = { schema, values, provenance, writable };
	const settings: Settings = { ...block, etag: settingsEtag(block) };

	return discoveryDocumentSchema.parse({
		v: DISCOVERY_VERSION.major,
		kind: 'drupal',
		version: input.release.version,
		releaseId: input.release.releaseId,
		schemaVersion: input.release.schemaVersion,
		capabilities: (input.capabilities ?? []).map(capabilityOf),
		settings,
		routes: [...ROUTES],
		redirects: REDIRECTS.map(([from, to]) => ({
			from,
			to: to.replace('{id}', encodeURIComponent(input.siteId))
		})),
		healthVocabulary: [...HEALTH_VOCABULARY],
		limits: input.limits ?? DRUPAL_LIMITS
	});
}

function authHeaders(site: DiscoverySite): Record<string, string> {
	return { authorization: `Bearer ${site.ownerToken}`, accept: 'application/json' };
}

async function readJson(res: Response, what: string): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		throw new DiscoveryError('malformed', `${what} is not JSON`);
	}
}

// a request that fails to connect or outlasts its timeout is unreachable
async function send(
	fetchFn: FetchLike,
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	try {
		return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		throw new DiscoveryError('unreachable', 'site did not answer');
	}
}

function isJsonAnswer(res: Response): boolean {
	const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return type === 'application/json' || type.endsWith('+json');
}

// a 404, or a 200 that is not JSON (a rendered page), means the site has no native document
export async function fetchDiscovery(
	site: DiscoverySite,
	fetchFn: FetchLike,
	timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<DiscoveryDocument> {
	const direct = await send(
		fetchFn,
		new URL(DISCOVERY_PATH, site.origin).href,
		{ method: 'GET', headers: authHeaders(site) },
		timeoutMs
	);
	if (direct.ok && isJsonAnswer(direct)) {
		const parsed = discoveryDocumentSchema.safeParse(await readJson(direct, 'discovery'));
		if (!parsed.success) throw new DiscoveryError('malformed', 'discovery document is invalid');
		return parsed.data;
	}
	if (!direct.ok && direct.status !== 404) {
		throw new DiscoveryError('status', `discovery answered ${direct.status}`);
	}

	const settingsRes = await send(
		fetchFn,
		new URL('/settings', site.origin).href,
		{ method: 'GET', headers: authHeaders(site) },
		timeoutMs
	);
	if (!settingsRes.ok) {
		throw new DiscoveryError('status', `settings answered ${settingsRes.status}`);
	}
	const settings = settingsResponseSchema.safeParse(await readJson(settingsRes, 'settings'));
	if (!settings.success) throw new DiscoveryError('malformed', 'settings answer is invalid');
	return composeDrupalDiscovery({
		settings: settings.data,
		release: site.release,
		siteId: site.siteId
	});
}

export type WriteResult =
	| { ok: true }
	| { ok: false; kind: 'refused'; key: string; reason: string }
	| {
			ok: false;
			kind: 'conflict';
			key: string;
			server: unknown;
			snapshot: unknown;
			sent: unknown;
	  }
	| { ok: false; kind: 'rejected'; key: string; reason: string };

// snapshot is the value the caller read; the write goes out only when the site still holds it.
// the worker serves no etag today, so If-Match is sent only when the site returns one itself.
export async function writeSetting(
	site: DiscoverySite,
	key: string,
	value: unknown,
	snapshot: unknown,
	fetchFn: FetchLike
): Promise<WriteResult> {
	if (!isKvWritable(key)) {
		return { ok: false, kind: 'refused', key, reason: 'not an overridable setting' };
	}
	const url = new URL('/settings', site.origin).href;
	const read = await send(
		fetchFn,
		url,
		{ method: 'GET', headers: authHeaders(site) },
		DISCOVERY_TIMEOUT_MS
	).catch(() => undefined);
	if (read === undefined)
		return { ok: false, kind: 'rejected', key, reason: 'site did not answer' };
	if (!read.ok)
		return { ok: false, kind: 'rejected', key, reason: `read answered ${read.status}` };
	const fresh = settingsResponseSchema.safeParse(await read.json().catch(() => undefined));
	if (!fresh.success)
		return { ok: false, kind: 'rejected', key, reason: 'read answer is invalid' };
	const lever = fresh.data.levers.find((l) => l.name === key);
	const server = lever ? valueOf(lever) : null;
	if (server !== snapshot) {
		return { ok: false, kind: 'conflict', key, server, snapshot, sent: value };
	}

	const siteEtag = read.headers.get('etag');
	const res = await send(
		fetchFn,
		url,
		{
			method: 'PUT',
			headers: {
				...authHeaders(site),
				'content-type': 'application/json',
				...(siteEtag !== null ? { 'if-match': siteEtag } : {})
			},
			body: JSON.stringify({ [key]: value })
		},
		DISCOVERY_TIMEOUT_MS
	).catch(() => undefined);
	if (res === undefined)
		return { ok: false, kind: 'rejected', key, reason: 'site did not answer' };
	if (res.status === 412) {
		const body = (await res.json().catch(() => ({}))) as { value?: unknown };
		return {
			ok: false,
			kind: 'conflict',
			key,
			server: body.value ?? null,
			snapshot,
			sent: value
		};
	}
	if (!res.ok) return { ok: false, kind: 'rejected', key, reason: `site answered ${res.status}` };
	const body = (await res.json().catch(() => ({}))) as {
		refused?: string[];
		invalid?: { name: string; reason: string }[];
	};
	if (body.invalid?.length) {
		return { ok: false, kind: 'rejected', key, reason: body.invalid[0]!.reason };
	}
	if (body.refused?.length) {
		return { ok: false, kind: 'rejected', key, reason: `refused: ${body.refused.join(', ')}` };
	}
	return { ok: true };
}
