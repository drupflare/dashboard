import {
	COMMON_VERSION,
	CONTRACT_HEADER,
	formatContractHeader,
	negotiate,
	parseContractHeader,
	supportedRange,
	type SupportPolicy
} from '@contracts/common';
import {
	defineEventHandler,
	getMethod,
	getRequestHeader,
	getRequestURL,
	getResponseStatus,
	getRouterParams,
	parseCookies,
	setResponseHeader,
	setResponseHeaders,
	setResponseStatus,
	type EventHandler,
	type H3Event
} from 'h3';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
	actionDef,
	isAction,
	isPublicAction,
	isSessionOnly,
	type Action,
	type PublicAction
} from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { API_TAG_NAMES, type ApiTag } from '../api-tags';
import {
	authorize,
	type Decision,
	type DenyDetail,
	type DenyReason,
	type Facts,
	type Principal,
	type Resource,
	type Via
} from '../domain/authorize';
import { sha256Hex } from '../services/crypto';
import { truncateIp } from '../services/sessions';
import type { AccessIdentity } from './access';
import { toApiError } from './errors';
import {
	checkIdempotency,
	parseIdempotencyKey,
	requestFingerprint,
	type IdempotencyStore
} from './idempotency';
import {
	ROUTE_CLASSES,
	rateLimitHeaders,
	slideWindow,
	type LimitClass,
	type RateConfig,
	type RateDecision,
	type RouteClass
} from './rate-limit';
import { parseBody, parseQuery, readCappedBody } from './request';

// #region meta

export const ROUTE_SCOPES = ['public', 'session', 'organization', 'site', 'admin'] as const;
export type RouteScope = (typeof ROUTE_SCOPES)[number];

export const SUCCESS_STATUSES = [200, 201, 202, 204] as const;
export type SuccessStatus = (typeof SUCCESS_STATUSES)[number];

export const API_CONTRACT = 'common';

type MaybeSchema = z.ZodType | undefined;

interface RouteMeta<
	P extends MaybeSchema,
	Q extends MaybeSchema,
	B extends MaybeSchema,
	R extends MaybeSchema
> {
	rateClass: RouteClass;
	tags: readonly ApiTag[];
	summary: string;
	description?: string;
	params?: P;
	query?: Q;
	body?: B;
	response?: R;
	successStatus?: SuccessStatus;
}

export type ApiMeta<
	P extends MaybeSchema = undefined,
	Q extends MaybeSchema = undefined,
	B extends MaybeSchema = undefined,
	R extends MaybeSchema = undefined
> = RouteMeta<P, Q, B, R> &
	(
		| { scope: 'public'; action: PublicAction }
		| { scope: Exclude<RouteScope, 'public'>; action: Action }
	);

export type AnyApiMeta = ApiMeta<MaybeSchema, MaybeSchema, MaybeSchema, MaybeSchema>;

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;
type In<S> = S extends z.ZodType ? z.input<S> : unknown;

export type AllowDecision = Extract<Decision, { allow: true }>;

export interface ApiContext<P, Q, B> {
	event: H3Event;
	requestId: string;
	principal: Principal | null;
	params: Out<P>;
	query: Out<Q>;
	body: Out<B>;
	resource: Resource;
	facts: Facts | null;
	decision: AllowDecision | null;
	idempotencyKey: string | undefined;
}

export const API_HANDLER = Symbol.for('drupflare.defineApi');

export type ApiHandler<M extends AnyApiMeta = AnyApiMeta> = EventHandler & {
	readonly meta: M;
	readonly [API_HANDLER]: true;
};

// #endregion

// #region collaborators

export type Credential =
	{ kind: 'bearer'; token: string } | { kind: 'cookies'; cookies: Record<string, string> };

export interface LoadInput {
	principal: Principal;
	scope: Exclude<RouteScope, 'public'>;
	action: Action;
	params: Record<string, string>;
	// the identity Cloudflare Access verified for this request, read only on the admin scope
	access?: AccessIdentity | null;
}

export interface Loaded {
	resource: Resource;
	facts: Facts;
}

export interface AuditRecord {
	requestId: string;
	principal: Principal;
	action: Action;
	via: Via;
	orgIds: readonly string[];
	resource: Resource;
	method: string;
	path: string;
}

export interface OwnerNotice {
	requestId: string;
	orgId: string;
	principal: Principal;
	action: Action;
	via: Via;
}

export type Limiter = (input: { routeClass: LimitClass; key: string }) => Promise<RateDecision>;

export interface DenialRecord {
	requestId: string;
	principal: Principal;
	action: Action;
	reason: DenyReason;
	detail?: DenyDetail;
	resource: Resource;
	method: string;
	path: string;
}

export interface ApiDeps {
	newRequestId(): string;
	contractPolicy: SupportPolicy;
	maxBodyBytes: number;
	resolvePrincipal(credential: Credential): Promise<Principal | null>;
	limit: Limiter;
	load(input: LoadInput): Promise<Loaded | null>;
	access?(event: H3Event): Promise<AccessIdentity | null>;
	idempotency: IdempotencyStore;
	audit(record: AuditRecord): Promise<void>;
	// a refusal is recorded best effort; a failed write is logged and the refusal still goes out
	auditDenied(record: DenialRecord): Promise<void>;
	notifyOwners(notice: OwnerNotice): Promise<void>;
	logError(error: unknown, requestId: string): void;
}

// placeholder numbers until the limiter object and plan limits land; only auth-code is from the plan.
// auth-code counts per address; auth-code-ip is the ceiling per network, high enough for a campus
export const PLACEHOLDER_RATES: RateConfig = {
	'auth-code': { limit: 5, windowMs: 10 * 60_000 },
	'auth-code-ip': { limit: 300, windowMs: 10 * 60_000 },
	read: { limit: 300, windowMs: 60_000 },
	write: { limit: 60, windowMs: 60_000 },
	heavy: { limit: 10, windowMs: 60_000 },
	webhook: { limit: 1000, windowMs: 60_000 },
	// each preflight call makes up to four outbound requests, so it is the tightest public class;
	// the ceiling counts every caller together, and each isolate keeps its own count
	preflight: { limit: 10, windowMs: 10 * 60_000 },
	'preflight-global': { limit: 200, windowMs: 10 * 60_000 }
};

export const MAX_TRACKED_KEYS = 10_000;

type Tracked = { timestamps: number[]; full: boolean; staleAt: number };

// frees one slot: the oldest key that is under its limit or whose window has passed, so a flood of
// cheap keys never pushes out a key that is at its limit; if every key is at its limit, the oldest
function evictOne(windows: Map<string, Tracked>, now: number): void {
	let oldest: string | undefined;
	for (const [id, entry] of windows) {
		oldest ??= id;
		if (!entry.full || entry.staleAt <= now) {
			windows.delete(id);
			return;
		}
	}
	if (oldest !== undefined) windows.delete(oldest);
}

export function memoryLimiter(rates: RateConfig, maxKeys = MAX_TRACKED_KEYS): Limiter {
	const windows = new Map<string, Tracked>();
	return async ({ routeClass, key }) => {
		const id = `${routeClass}|${key}`;
		const now = nowUtc().toMillis();
		const rule = rates[routeClass];
		const decision = slideWindow(windows.get(id)?.timestamps ?? [], now, rule);
		// a touched key moves to the newest end, so iteration order is oldest first
		if (!windows.delete(id) && windows.size >= maxKeys) evictOne(windows, now);
		windows.set(id, {
			timestamps: decision.timestamps,
			full: decision.remaining <= 0,
			staleAt: (decision.timestamps.at(-1) ?? now) + rule.windowMs
		});
		return decision;
	};
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

// the one place production collaborators are chosen; each unbuilt piece fails closed
export function productionDeps(): ApiDeps {
	return {
		newRequestId: () => `req_${crypto.randomUUID().replaceAll('-', '')}`,
		contractPolicy: { current: COMMON_VERSION },
		maxBodyBytes: 1024 * 1024,
		resolvePrincipal: async () => null,
		limit: memoryLimiter(PLACEHOLDER_RATES),
		load: notBuilt('The facts loader'),
		idempotency: {
			claim: notBuilt('The idempotency store'),
			put: notBuilt('The idempotency store'),
			release: notBuilt('The idempotency store')
		},
		audit: notBuilt('The audit writer'),
		auditDenied: async () => undefined,
		notifyOwners: notBuilt('Owner notification'),
		logError: (error, requestId) => console.error(requestId, error)
	};
}

let active: ApiDeps = productionDeps();

export function setApiDeps(over: Partial<ApiDeps>): void {
	active = { ...productionDeps(), ...over };
}

export function resetApiDeps(): void {
	active = productionDeps();
}

// #endregion

// #region definition

const SCOPE_ACTION_SCOPES = {
	session: ['account'],
	organization: ['org', 'department'],
	site: ['site'],
	admin: ['admin']
} as const;

function bad(message: string): never {
	throw new Error(`defineApi: ${message}`);
}

function assertMeta(meta: AnyApiMeta): void {
	if (meta === null || typeof meta !== 'object') bad('meta is required');
	const { action, scope } = meta as { action?: unknown; scope?: unknown };
	if (typeof action !== 'string' || action === '') bad('action is required');
	if (!(ROUTE_SCOPES as readonly unknown[]).includes(scope))
		bad(`unknown scope ${String(scope)}`);
	if (scope === 'public') {
		if (!isPublicAction(action)) bad(`a public route needs a public action, got ${action}`);
	} else {
		if (!isAction(action)) bad(`action ${action} is not in the permission table`);
		const allowed: readonly string[] =
			SCOPE_ACTION_SCOPES[scope as keyof typeof SCOPE_ACTION_SCOPES];
		const actual = actionDef(action).scope;
		if (!allowed.includes(actual)) {
			bad(`action ${action} has scope ${actual} and cannot sit on a ${String(scope)} route`);
		}
	}
	if (!(ROUTE_CLASSES as readonly unknown[]).includes(meta.rateClass)) {
		bad(`unknown rate class ${String(meta.rateClass)}`);
	}
	if (!Array.isArray(meta.tags) || meta.tags.length === 0) bad('tags is required');
	for (const tag of meta.tags)
		if (!API_TAG_NAMES.includes(tag)) bad(`unknown tag ${String(tag)}`);
	if (typeof meta.summary !== 'string' || meta.summary.trim() === '') bad('summary is required');
	const status: unknown = meta.successStatus;
	if (status !== undefined && !(SUCCESS_STATUSES as readonly unknown[]).includes(status)) {
		bad(`unsupported successStatus ${String(status)}`);
	}
	if (status === 204 && meta.response) bad('a 204 route cannot declare a response');
}

export function isApiHandler(value: unknown): value is ApiHandler {
	return typeof value === 'function' && (value as Partial<ApiHandler>)[API_HANDLER] === true;
}

export function defineApi<
	P extends MaybeSchema = undefined,
	Q extends MaybeSchema = undefined,
	B extends MaybeSchema = undefined,
	R extends MaybeSchema = undefined
>(
	meta: ApiMeta<P, Q, B, R>,
	handler: (ctx: ApiContext<P, Q, B>) => In<R> | Promise<In<R>>
): ApiHandler<ApiMeta<P, Q, B, R>> {
	assertMeta(meta as AnyApiMeta);
	const wrapped = defineEventHandler((event) =>
		serve(
			event,
			meta as AnyApiMeta,
			handler as (ctx: ApiContext<never, never, never>) => unknown
		)
	);
	return Object.assign(wrapped, { meta, [API_HANDLER]: true as const });
}

// #endregion

// #region pipeline

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function principalKey(principal: Principal): string {
	return principal.kind === 'user' ? `user:${principal.userId}` : `key:${principal.keyId}`;
}

function toDetails(details: unknown): Record<string, unknown> {
	if (details === null || details === undefined) return {};
	if (Array.isArray(details)) return { issues: details };
	if (typeof details === 'object') return details as Record<string, unknown>;
	return { value: details };
}

function respond(event: H3Event, status: number, body: unknown): string | null {
	setResponseStatus(event, status);
	if (status === 204) return null;
	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	return JSON.stringify(body);
}

function fail(event: H3Event, error: unknown, requestId: string, deps: ApiDeps): string | null {
	const apiError = toApiError(error);
	if (apiError.code === 'internal') deps.logError(error, requestId);
	return respond(event, apiError.status, {
		code: apiError.code,
		message: apiError.message,
		details: toDetails(apiError.details),
		requestId
	});
}

function negotiateContract(event: H3Event, deps: ApiDeps, requestId: string): void {
	const now = new Date(nowUtc().toMillis());
	const range = supportedRange(deps.contractPolicy, now);
	setResponseHeader(event, CONTRACT_HEADER, formatContractHeader(API_CONTRACT, range));
	const header = getRequestHeader(event, CONTRACT_HEADER);
	if (header === undefined) return;
	const parsed = parseContractHeader(header);
	if (!parsed) throw new ApiError('validation', `${CONTRACT_HEADER} header is malformed`);
	if (parsed.contract !== API_CONTRACT) return;
	const result = negotiate(parsed.range, deps.contractPolicy, { now, requestId });
	if (!result.ok) {
		throw new ApiError('contract_unsupported', result.body.message, result.body.details);
	}
}

function credentialOf(event: H3Event): Credential {
	const header = getRequestHeader(event, 'authorization');
	if (header === undefined) return { kind: 'cookies', cookies: parseCookies(event) };
	const match = /^Bearer (dfk_\S+)$/i.exec(header);
	if (!match?.[1]) throw new ApiError('unauthenticated', 'Authentication is required');
	return { kind: 'bearer', token: match[1] };
}

async function authenticate(event: H3Event, deps: ApiDeps): Promise<Principal | null> {
	let credential: Credential;
	try {
		credential = credentialOf(event);
	} catch {
		return null;
	}
	const principal = await deps.resolvePrincipal(credential);
	if (principal === null) return null;
	// a bearer token only ever names a key, and a cookie only ever names a user
	const expected = credential.kind === 'bearer' ? 'key' : 'user';
	return principal.kind === expected ? principal : null;
}

const IPV4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i;

// an ipv6 caller controls a whole /64, so the bucket is the prefix and not the address
function addressBucket(address: string | undefined): string {
	if (!address) return 'unknown';
	const v4 = IPV4.exec(address)?.[1];
	if (v4) return v4;
	return address.includes(':') ? (truncateIp(address) ?? address) : address;
}

// cloudflare sets this header at the edge, so it is only trustworthy behind cloudflare
function callerKey(event: H3Event, principal: Principal | null): string {
	if (principal) return principalKey(principal);
	return `ip:${addressBucket(getRequestHeader(event, 'cf-connecting-ip'))}`;
}

async function limit(
	event: H3Event,
	deps: ApiDeps,
	routeClass: LimitClass,
	key: string
): Promise<void> {
	const decision = await deps.limit({ routeClass, key });
	setResponseHeaders(event, rateLimitHeaders(decision));
	if (!decision.allowed) {
		throw new ApiError('rate_limited', 'Too many requests', {
			retryAfterSeconds: decision.retryAfterSeconds
		});
	}
}

// an anonymous auth-code request counts against its network's ceiling here, and against its own
// address once the body is read, so one campus address does not lock out the people behind it
async function throttle(
	event: H3Event,
	meta: AnyApiMeta,
	principal: Principal | null,
	deps: ApiDeps
): Promise<void> {
	const routeClass =
		meta.rateClass === 'auth-code' && principal === null ? 'auth-code-ip' : meta.rateClass;
	await limit(event, deps, routeClass, callerKey(event, principal));
	// a caller inside its own preflight limit still counts against the shared ceiling
	if (meta.rateClass === 'preflight') await limit(event, deps, 'preflight-global', 'all');
}

// the auth-code class also counts per address: the email a body names, lower case and trimmed
async function throttleAddress(
	event: H3Event,
	meta: AnyApiMeta,
	principal: Principal | null,
	body: unknown,
	deps: ApiDeps
): Promise<void> {
	if (meta.rateClass !== 'auth-code' || principal !== null) return;
	const email = (body as { email?: unknown } | null)?.email;
	if (typeof email !== 'string') return;
	await limit(event, deps, 'auth-code', `email:${await sha256Hex(email.trim().toLowerCase())}`);
}

async function readJsonBody(event: H3Event, maxBytes: number): Promise<string> {
	const type = getRequestHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (type !== 'application/json' && !type.endsWith('+json')) {
		throw new ApiError('validation', 'Content-Type must be application/json');
	}
	return readCappedBody(event, maxBytes);
}

export function denial(decision: Extract<Decision, { allow: false }>): ApiError {
	// only denials reached after membership is proven say what to do next
	switch (decision.reason) {
		case 'step_up_required':
			return new ApiError('forbidden', 'Fresh authentication is required', {
				requires: 'step-up'
			});
		case 'entitlement_required':
			return new ApiError('forbidden', 'Your plan does not include this feature', {
				requires: 'entitlement',
				feature: decision.detail?.feature
			});
		case 'budget_exceeded':
			return new ApiError('forbidden', 'The change budget for this action is used up', {
				requires: 'budget',
				budget: decision.detail?.budget
			});
		default:
			return new ApiError('forbidden', 'You do not have access to this resource');
	}
}

async function serve(
	event: H3Event,
	meta: AnyApiMeta,
	handler: (ctx: ApiContext<never, never, never>) => unknown
): Promise<string | null | Response> {
	const deps = active;
	const requestId = deps.newRequestId();
	setResponseHeader(event, 'X-Request-Id', requestId);
	// only a route marked public may be cached; a handler can still set its own value
	if (meta.scope !== 'public') setResponseHeader(event, 'Cache-Control', 'no-store');
	const stages: Record<string, number> = {};
	const startedAt = Date.now();
	let status = 0;
	try {
		const result = await pipeline(event, meta, handler, deps, requestId, stages);
		status = getResponseStatus(event);
		return result;
	} catch (error) {
		const answer = fail(event, error, requestId, deps);
		status = getResponseStatus(event);
		return answer;
	} finally {
		console.info(
			'api.timing',
			JSON.stringify({ action: meta.action, status, totalMs: Date.now() - startedAt, stages })
		);
	}
}

async function pipeline(
	event: H3Event,
	meta: AnyApiMeta,
	handler: (ctx: ApiContext<never, never, never>) => unknown,
	deps: ApiDeps,
	requestId: string,
	stages: Record<string, number>
): Promise<string | null | Response> {
	const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
		const at = Date.now();
		try {
			return await run();
		} finally {
			stages[name] = (stages[name] ?? 0) + (Date.now() - at);
		}
	};
	const method = getMethod(event).toUpperCase();
	const url = getRequestURL(event);
	const isPublic = meta.scope === 'public';

	negotiateContract(event, deps, requestId);

	const principal = isPublic ? null : await timed('auth', () => authenticate(event, deps));
	await timed('throttle', () => throttle(event, meta, principal, deps));
	if (!isPublic && principal === null) {
		throw new ApiError('unauthenticated', 'Authentication is required');
	}

	// an authenticated refusal is written to the audit trail before it goes out
	const refuse = async (
		result: Extract<Decision, { allow: false }>,
		resource: Resource
	): Promise<never> => {
		if (principal !== null) {
			try {
				await deps.auditDenied({
					requestId,
					principal,
					action: meta.action as Action,
					reason: result.reason,
					...(result.detail ? { detail: result.detail } : {}),
					resource,
					method,
					path: url.pathname
				});
			} catch (error) {
				deps.logError(error, requestId);
			}
		}
		throw denial(result);
	};

	if (principal?.kind === 'key' && isSessionOnly(meta.action as Action)) {
		return refuse({ allow: false, reason: 'session_only' }, {});
	}

	const rawParams = getRouterParams(event, { decode: true });
	const params = meta.params
		? parseQuery(meta.params, new URLSearchParams(rawParams))
		: undefined;
	const query = meta.query ? parseQuery(meta.query, url.searchParams) : undefined;
	const write = WRITE_METHODS.includes(method);
	const idempotencyKey = write
		? parseIdempotencyKey(getRequestHeader(event, 'idempotency-key'))
		: undefined;
	let rawBody = '';
	let body: unknown;
	if (meta.body) {
		rawBody = await readJsonBody(event, deps.maxBodyBytes);
		body = parseBody(meta.body, rawBody, deps.maxBodyBytes);
		await throttleAddress(event, meta, principal, body, deps);
	}

	let resource: Resource = {};
	let facts: Facts | null = null;
	let decision: AllowDecision | null = null;
	if (principal !== null && meta.scope !== 'public') {
		const loaded = await timed('load', async () =>
			deps.load({
				principal,
				scope: meta.scope,
				action: meta.action,
				params: rawParams,
				access: meta.scope === 'admin' ? ((await deps.access?.(event)) ?? null) : null
			})
		);
		if (loaded === null) throw new ApiError('not_found', 'Not found');
		({ resource, facts } = loaded);
		const result = authorize({ principal, action: meta.action, resource, facts });
		if (!result.allow) return refuse(result, resource);
		decision = result;
	}

	let storeKey: string | undefined;
	let fingerprint = '';
	if (idempotencyKey !== undefined) {
		storeKey = [callerKey(event, principal), resource.orgId ?? '-', idempotencyKey].join('|');
		fingerprint = await requestFingerprint(method, url.pathname + url.search, rawBody);
		const claim = await checkIdempotency(deps.idempotency, storeKey, fingerprint);
		if (claim.kind === 'replay') {
			setResponseHeader(event, 'Idempotency-Replayed', 'true');
			return respond(event, claim.status, claim.body);
		}
		if (claim.kind === 'pending') {
			setResponseHeader(event, 'Retry-After', 1);
			throw new ApiError('conflict', 'A request with this Idempotency-Key is still running', {
				reason: 'idempotency_pending',
				retryAfterSeconds: 1
			});
		}
	}

	try {
		if (decision !== null && principal !== null) {
			const audited =
				write ||
				decision.via === 'delegation' ||
				decision.via === 'support-grant' ||
				decision.via === 'break-glass';
			if (audited && decision.audit.length > 0) {
				await timed('audit', () =>
					deps.audit({
						requestId,
						principal,
						action: meta.action as Action,
						via: decision.via,
						orgIds: decision.audit,
						resource,
						method,
						path: url.pathname
					})
				);
			}
			if (decision.notifyOwners !== undefined) {
				await deps.notifyOwners({
					requestId,
					orgId: decision.notifyOwners,
					principal,
					action: meta.action as Action,
					via: decision.via
				});
			}
		}

		const status = meta.successStatus ?? 200;
		const result = await timed('handler', async () =>
			handler({
				event,
				requestId,
				principal,
				params,
				query,
				body,
				resource,
				facts,
				decision,
				idempotencyKey
			} as ApiContext<never, never, never>)
		);
		if (result instanceof Response) {
			if (storeKey !== undefined) {
				throw new Error('defineApi: a raw response cannot be stored for replay');
			}
			return result;
		}
		if (status !== 204 && result === undefined) {
			throw new Error(`defineApi: handler for ${meta.action} returned nothing`);
		}

		if (storeKey !== undefined) {
			try {
				await deps.idempotency.put(storeKey, { fingerprint, status, body: result ?? null });
			} catch (error) {
				deps.logError(error, requestId);
			}
		}
		return respond(event, status, result);
	} catch (error) {
		// the claim is ours, so a failed request frees the key for a retry
		if (storeKey !== undefined) {
			await deps.idempotency.release(storeKey).catch((releaseError: unknown) => {
				deps.logError(releaseError, requestId);
			});
		}
		throw error;
	}
}

// #endregion
