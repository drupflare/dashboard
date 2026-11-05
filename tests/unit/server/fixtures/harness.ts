import { createApp, createRouter, toWebHandler, type EventHandler } from 'h3';
import type { Facts, Principal } from '../../../../src/server/domain/authorize';
import {
	setApiDeps,
	type ApiDeps,
	type AuditRecord,
	type Loaded,
	type LoadInput,
	type OwnerNotice
} from '../../../../src/server/utils/define-api';
import { createMemoryStore } from '../../../../src/server/utils/idempotency';
import { slideWindow, type RateDecision } from '../../../../src/server/utils/rate-limit';
import type { OrgRole } from '../../../../src/shared/permissions';
import { DEPT, facts, fresh, member, ORG, OTHER_ORG, SITE } from '../../domain/fixtures';

export const USER_A: Principal = { kind: 'user', userId: 'user-1' };
export const USER_B: Principal = { kind: 'user', userId: 'user-2' };
export const KEY: Principal = { kind: 'key', keyId: 'key-1', issuerId: 'user-1' };

export const SITES: Record<string, string> = { [SITE]: ORG, 'site-2': OTHER_ORG };
export const ORGS = [ORG, OTHER_ORG];

const COOKIE_USERS: Record<string, Principal> = { 'token-a': USER_A, 'token-b': USER_B };
const BEARER_KEYS: Record<string, Principal> = { dfk_key1: KEY };

export interface Request {
	method?: string;
	path: string;
	headers?: Record<string, string>;
	json?: unknown;
	raw?: string;
}

export interface Reply {
	status: number;
	headers: Headers;
	text: string;
	json: unknown;
}

export async function send(handler: EventHandler, route: string, req: Request): Promise<Reply> {
	const method = (req.method ?? 'GET').toUpperCase();
	const router = createRouter();
	router.add(route, handler, method.toLowerCase() as 'get');
	const app = createApp();
	app.use(router);
	const headers = { ...req.headers };
	let body: string | undefined = req.raw;
	if (req.json !== undefined) {
		body = JSON.stringify(req.json);
		headers['content-type'] ??= 'application/json';
	}
	const response = await toWebHandler(app)(
		new Request(`http://localhost${req.path}`, { method, headers, body })
	);
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, headers: response.headers, text, json };
}

export const asUser = { cookie: 'session=token-a' };
export const asOtherUser = { cookie: 'session=token-b' };
export const asKey = { authorization: 'Bearer dfk_key1' };

export interface Setup {
	role?: OrgRole | null;
	facts?: (input: LoadInput) => Facts;
	deps?: Partial<ApiDeps>;
	allow?: (key: string) => RateDecision | null;
}

// a world with two organisations, two sites and one member; every collaborator is a recording fake
export function setup(options: Setup = {}) {
	const audits: AuditRecord[] = [];
	const notices: OwnerNotice[] = [];
	const errors: unknown[] = [];
	const loads: LoadInput[] = [];
	const limits: { routeClass: string; key: string }[] = [];
	const windows = new Map<string, number[]>();
	let counter = 0;
	const role = options.role === undefined ? 'owner' : options.role;

	const defaultFacts = (input: LoadInput): Facts => {
		const base = role === null ? facts({ ...fresh }) : facts({ ...member(role), ...fresh });
		if (input.principal.kind !== 'key') return base;
		return {
			...base,
			key: { id: input.principal.keyId, scopes: ['site.read', 'member.read'] }
		};
	};

	const load = async (input: LoadInput): Promise<Loaded | null> => {
		loads.push(input);
		const resource: Loaded['resource'] = {};
		if (input.scope === 'site') {
			const orgId = SITES[input.params.id ?? ''];
			if (orgId === undefined) return null;
			Object.assign(resource, { orgId, siteId: input.params.id, departmentId: DEPT });
		} else if (input.scope === 'organization') {
			const orgId = input.params.orgId;
			if (orgId === undefined || !ORGS.includes(orgId)) return null;
			Object.assign(resource, { orgId, departmentId: DEPT });
		}
		return { resource, facts: (options.facts ?? defaultFacts)(input) };
	};

	const deps: ApiDeps = {
		newRequestId: () => `req_test${++counter}`,
		contractPolicy: { current: { major: 1, minor: 0 } },
		maxBodyBytes: 1024,
		resolvePrincipal: async (credential) =>
			credential.kind === 'bearer'
				? (BEARER_KEYS[credential.token] ?? null)
				: (COOKIE_USERS[credential.cookies.session ?? ''] ?? null),
		limit: async (input) => {
			limits.push(input);
			const preset = options.allow?.(input.key);
			if (preset) return preset;
			const id = `${input.routeClass}|${input.key}`;
			const decision = slideWindow(windows.get(id) ?? [], 1000, {
				limit: 1000,
				windowMs: 60_000
			});
			windows.set(id, decision.timestamps);
			return decision;
		},
		load,
		idempotency: createMemoryStore(),
		audit: async (record) => {
			audits.push(record);
		},
		notifyOwners: async (notice) => {
			notices.push(notice);
		},
		logError: (error) => {
			errors.push(error);
		},
		...options.deps
	};
	setApiDeps(deps);
	return { deps, audits, notices, errors, loads, limits };
}
