import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { z } from 'zod';
import { COMMON_VERSION, errorEnvelope } from '../contracts/src/common';
import { API_TAGS } from '../src/server/api-tags';
import { keyUsable } from '../src/server/domain/scopes';
import { isAction, isPublicAction } from '../src/shared/permissions';

const here = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(here, '../src/server/api');
export const OUTPUT = resolve(here, '../contracts/openapi.json');

// mirrors the cookie name in the sessions service
const SESSION_COOKIE_NAME = '__Host-drupflare_session';

// the only host a client may send a credential to; an MCP gateway reads it from the servers list
export const PRODUCTION_ORIGIN = 'https://app.drupflare.com';

// MCP clients refuse a tool name longer than this, and the tool name is the operation id
export const MAX_OPERATION_ID = 64;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type Method = (typeof METHODS)[number];

const FORMAT = {
	parser: 'json',
	printWidth: 100,
	useTabs: true,
	tabWidth: 4,
	trailingComma: 'none',
	endOfLine: 'lf'
} as const;

// #region route files

const UNVERSIONED_FILES = ['health.get.ts', 'index.get.ts', 'openapi.json.get.ts'];
const UNVERSIONED_DIRS = ['hooks'];

export function isAllowListed(rel: string): boolean {
	return (
		UNVERSIONED_FILES.includes(rel) || UNVERSIONED_DIRS.some((dir) => rel.startsWith(`${dir}/`))
	);
}

export function listRouteFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith('.ts')) out.push(relative(root, full).split('\\').join('/'));
		}
	};
	walk(root);
	return out;
}

interface Located {
	method: Method;
	path: string;
}

// nitro file-route naming: name.method.ts, [id] for a parameter, index for the folder itself
function locate(rel: string): Located | string {
	const segments = rel.slice(0, -'.ts'.length).split('/');
	const last = segments.pop() as string;
	const dot = last.lastIndexOf('.');
	const method = dot === -1 ? '' : last.slice(dot + 1);
	if (!(METHODS as readonly string[]).includes(method)) {
		return 'file name needs a method suffix such as .get.ts';
	}
	const name = last.slice(0, dot);
	if (segments[0] !== 'v1') return 'route files outside the allow-list must live under v1/';
	for (const part of [...segments, name]) {
		if (part.startsWith('[...')) return 'catch-all routes are not supported';
	}
	const parts = name === 'index' ? segments : [...segments, name];
	const path = `/api/${parts.map((part) => part.replace(/^\[(.+)\]$/, '{$1}')).join('/')}`;
	return { method: method as Method, path };
}

// #endregion

// #region scan

export interface RouteMetaLike {
	scope: string;
	action: string;
	rateClass: string;
	tags: readonly string[];
	summary: string;
	description?: string;
	params?: z.ZodType;
	query?: z.ZodType;
	body?: z.ZodType;
	response?: z.ZodType;
	successStatus?: number;
}

export interface RouteEntry {
	rel: string;
	method: Method;
	path: string;
	meta: RouteMetaLike;
}

export interface ScanResult {
	routes: RouteEntry[];
	problems: string[];
}

export const HANDLER_BRAND = Symbol.for('drupflare.defineApi');

function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): Record<string, unknown> {
	// nothing parses a response, so the wire value has the input shape
	const { $schema: _dialect, ...body } = z.toJSONSchema(schema, {
		io,
		cycles: 'throw',
		reused: 'inline'
	}) as Record<string, unknown>;
	return body;
}

function objectProperties(schema: z.ZodType): Record<string, Record<string, unknown>> | null {
	const json = jsonSchema(schema);
	if (json.type !== 'object') return null;
	return (json.properties ?? {}) as Record<string, Record<string, unknown>>;
}

function isApiResult(value: unknown): value is { meta: RouteMetaLike } {
	if (typeof value !== 'function') return false;
	const branded = (value as { [HANDLER_BRAND]?: unknown })[HANDLER_BRAND] === true;
	return branded && typeof (value as { meta?: unknown }).meta === 'object';
}

function pathParams(path: string): string[] {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
}

export async function scanRoutes(root: string = API_ROOT): Promise<ScanResult> {
	const routes: RouteEntry[] = [];
	const problems: string[] = [];
	const seen = new Map<string, string>();
	for (const rel of listRouteFiles(root)) {
		if (isAllowListed(rel)) continue;
		const located = locate(rel);
		if (typeof located === 'string') {
			problems.push(`${rel}: ${located}`);
			continue;
		}
		let mod: { default?: unknown };
		try {
			mod = (await import(join(root, rel))) as { default?: unknown };
		} catch (error) {
			problems.push(`${rel}: failed to import: ${(error as Error).message}`);
			continue;
		}
		if (!isApiResult(mod.default)) {
			problems.push(`${rel}: the default export is not a defineApi result`);
			continue;
		}
		const meta = mod.default.meta;
		const known = meta.scope === 'public' ? isPublicAction(meta.action) : isAction(meta.action);
		if (!known) {
			problems.push(`${rel}: action ${meta.action} is not registered`);
			continue;
		}
		const operation = `${located.method.toUpperCase()} ${located.path}`;
		const earlier = seen.get(operation);
		if (earlier) {
			problems.push(`${rel}: ${operation} is already served by ${earlier}`);
			continue;
		}
		seen.set(operation, rel);

		const wanted = pathParams(located.path);
		const declared = meta.params ? objectProperties(meta.params) : {};
		if (declared === null) {
			problems.push(`${rel}: params must be an object schema`);
			continue;
		}
		const names = Object.keys(declared);
		const missing = wanted.filter((name) => !names.includes(name));
		const extra = names.filter((name) => !wanted.includes(name));
		if (missing.length > 0 || extra.length > 0) {
			problems.push(
				`${rel}: params must match the path (missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'})`
			);
			continue;
		}
		routes.push({ rel, ...located, meta });
	}
	return { routes, problems };
}

// #endregion

// #region document

const CONTRACT_HEADER = 'Drupflare-Contract';

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });

const RESPONSE_HEADERS = {
	'X-Request-Id': ref('headers', 'RequestId'),
	'Drupflare-Contract': ref('headers', 'Contract'),
	'RateLimit-Limit': ref('headers', 'RateLimitLimit'),
	'RateLimit-Remaining': ref('headers', 'RateLimitRemaining'),
	'RateLimit-Reset': ref('headers', 'RateLimitReset')
};

const header = (description: string, type: 'string' | 'integer') => ({
	description,
	schema: { type }
});

function errorResponse(description: string, extra: Record<string, unknown> = {}) {
	return {
		description,
		headers: { ...RESPONSE_HEADERS, ...extra },
		content: { 'application/json': { schema: ref('schemas', 'Error') } }
	};
}

function components() {
	return {
		securitySchemes: {
			session: {
				type: 'apiKey',
				in: 'cookie',
				name: SESSION_COOKIE_NAME,
				description: 'The session cookie set at sign-in.'
			},
			apiKey: {
				type: 'http',
				scheme: 'bearer',
				bearerFormat: 'dfk_',
				description:
					'An API key that starts with dfk_. An action that needs a signed-in session or a fresh sign-in refuses keys.'
			}
		},
		schemas: { Error: jsonSchema(errorEnvelope, 'output') },
		parameters: {
			ContractHeader: {
				name: CONTRACT_HEADER,
				in: 'header',
				required: false,
				description:
					'The contract versions the client understands, as common=<min>-<max>. A server that cannot serve the range answers 426.',
				schema: { type: 'string', pattern: '^[^=]+=\\d+\\.\\d+(-\\d+\\.\\d+)?$' }
			},
			IdempotencyKey: {
				name: 'Idempotency-Key',
				in: 'header',
				required: false,
				description:
					'Repeat a write safely. The same key with the same request returns the first result.',
				schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' }
			}
		},
		headers: {
			RequestId: header(
				'The id of this request. Quote it when you contact support.',
				'string'
			),
			Contract: header(
				'The contract versions this server supports, as common=<min>-<max>.',
				'string'
			),
			RateLimitLimit: header('Requests allowed in the current window.', 'integer'),
			RateLimitRemaining: header('Requests left in the current window.', 'integer'),
			RateLimitReset: header('Seconds until the window frees a slot.', 'integer'),
			RetryAfter: header('Seconds to wait before the next request.', 'integer')
		},
		responses: {
			BadRequest: errorResponse(
				'The request is invalid. details.issues lists each field path.'
			),
			Unauthenticated: errorResponse('The request has no valid session or API key.'),
			Forbidden: errorResponse('The caller may not do this.'),
			NotFound: errorResponse('The resource does not exist.'),
			Unprocessable: errorResponse('The Idempotency-Key was used for a different request.'),
			ContractUnsupported: errorResponse(
				'The server does not support the requested contract range. details.supported names the range it does.'
			),
			RateLimited: errorResponse('Too many requests.', {
				'Retry-After': ref('headers', 'RetryAfter')
			}),
			InternalError: errorResponse(
				'The server failed. Quote the requestId when you report it.'
			)
		}
	};
}

function parameters(
	location: 'path' | 'query',
	schema: z.ZodType | undefined
): Record<string, unknown>[] {
	if (!schema) return [];
	const json = jsonSchema(schema);
	const required = (json.required ?? []) as string[];
	const properties = (json.properties ?? {}) as Record<string, unknown>;
	return Object.entries(properties).map(([name, property]) => ({
		name,
		in: location,
		required: location === 'path' || required.includes(name),
		schema: property
	}));
}

function pascal(text: string): string {
	return text
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join('');
}

// a key can call only what keyUsable allows. The key comes first: a gateway that holds one
// Authorization value would otherwise satisfy the cookie scheme with it and never send the bearer
function security(action: string, scope: string): Record<string, string[]>[] {
	if (scope === 'public') return [];
	return isAction(action) && keyUsable(action)
		? [{ apiKey: [] }, { session: [] }]
		: [{ session: [] }];
}

function operation(route: RouteEntry): Record<string, unknown> {
	const { meta, method, path } = route;
	const write = method !== 'get';
	const status = meta.successStatus ?? 200;
	const success: Record<string, unknown> = {
		description: status === 204 ? 'Done. The response has no body.' : 'Success.',
		headers: RESPONSE_HEADERS
	};
	if (meta.response) {
		success.content = { 'application/json': { schema: jsonSchema(meta.response) } };
	}
	const responses: Record<string, unknown> = { [String(status)]: success };
	if (meta.params || meta.query || meta.body || write)
		responses['400'] = ref('responses', 'BadRequest');
	if (meta.scope !== 'public') {
		responses['401'] = ref('responses', 'Unauthenticated');
		responses['403'] = ref('responses', 'Forbidden');
	}
	if (meta.scope === 'organization' || meta.scope === 'site') {
		responses['404'] = ref('responses', 'NotFound');
	}
	if (write) responses['422'] = ref('responses', 'Unprocessable');
	responses['426'] = ref('responses', 'ContractUnsupported');
	responses['429'] = ref('responses', 'RateLimited');
	responses['500'] = ref('responses', 'InternalError');

	const operationId = `${method}${pascal(path)}`;
	if (operationId.length > MAX_OPERATION_ID) {
		throw new Error(
			`${operationId} is ${operationId.length} characters; the limit is ${MAX_OPERATION_ID}`
		);
	}
	const op: Record<string, unknown> = {
		operationId,
		summary: meta.summary,
		...(meta.description ? { description: meta.description } : {}),
		tags: [...meta.tags],
		'x-action': meta.action,
		'x-rate-class': meta.rateClass,
		security: security(meta.action, meta.scope),
		parameters: [
			...parameters('path', meta.params),
			...parameters('query', meta.query),
			ref('parameters', 'ContractHeader'),
			...(write ? [ref('parameters', 'IdempotencyKey')] : [])
		]
	};
	if (meta.body) {
		op.requestBody = {
			required: true,
			content: { 'application/json': { schema: jsonSchema(meta.body) } }
		};
	}
	op.responses = responses;
	return op;
}

export function buildSpec(routes: readonly RouteEntry[]): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	const ordered = [...routes].sort(
		(a, b) =>
			a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method)
	);
	for (const route of ordered) {
		(paths[route.path] ??= {})[route.method] = operation(route);
	}
	return {
		openapi: '3.1.0',
		info: {
			title: 'Drupflare Dashboard API',
			version: `${COMMON_VERSION.major}.${COMMON_VERSION.minor}.0`,
			description:
				'The HTTP API behind the Drupflare dashboard. Every operation names the permission it checks in x-action and its rate class in x-rate-class.'
		},
		servers: [{ url: PRODUCTION_ORIGIN, description: 'Production' }],
		tags: API_TAGS.map(({ name, description }) => ({ name, description })),
		paths,
		components: components()
	};
}

export async function renderOpenApi(root: string = API_ROOT): Promise<string> {
	const { routes, problems } = await scanRoutes(root);
	if (problems.length > 0) throw new Error(`route scan failed:\n${problems.join('\n')}`);
	return format(JSON.stringify(buildSpec(routes)), FORMAT);
}

// #endregion

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	writeFileSync(OUTPUT, await renderOpenApi());
}
