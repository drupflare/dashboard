import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorEnvelope } from '../../../contracts/src/common';
import {
	API_ROOT,
	HANDLER_BRAND,
	OUTPUT,
	renderOpenApi,
	scanRoutes
} from '../../../scripts/gen-openapi';
import { API_TAG_NAMES } from '../../../src/server/api-tags';
import { API_HANDLER } from '../../../src/server/utils/define-api';
import { parseIdempotencyKey } from '../../../src/server/utils/idempotency';
import { isAction, isPublicAction, isSessionOnly } from '../../../src/shared/permissions';
import { thrownBy } from '../server/utils/support';

const FIXTURES = join(import.meta.dirname, '../server/fixtures/api');
const BAD_FIXTURES = join(import.meta.dirname, '../server/fixtures/bad-api');

type Json = Record<string, any>;

let sample: Json;
let sampleText: string;

beforeAll(async () => {
	sampleText = await renderOpenApi(FIXTURES);
	sample = JSON.parse(sampleText);
});

function operations(doc: Json): { path: string; method: string; op: Json }[] {
	return Object.entries(doc.paths as Json).flatMap(([path, item]) =>
		Object.entries(item as Json).map(([method, op]) => ({ path, method, op: op as Json }))
	);
}

function refs(value: unknown, out: string[] = []): string[] {
	if (Array.isArray(value)) value.forEach((item) => refs(item, out));
	else if (value && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			if (key === '$ref' && typeof inner === 'string') out.push(inner);
			else refs(inner, out);
		}
	}
	return out;
}

function resolve(doc: Json, pointer: string): unknown {
	let node: any = doc;
	for (const part of pointer.replace(/^#\//, '').split('/')) node = node?.[part];
	return node;
}

describe('gen-openapi: committed file', () => {
	it('equals the generator output, so a route change cannot land without a regenerate', async () => {
		expect(readFileSync(OUTPUT, 'utf8')).toBe(await renderOpenApi(API_ROOT));
	});

	it('names a permission-table action on every operation it holds', () => {
		const committed = JSON.parse(readFileSync(OUTPUT, 'utf8')) as Json;
		for (const { path, method, op } of operations(committed)) {
			const action = op['x-action'];
			const known = op.security.length === 0 ? isPublicAction(action) : isAction(action);
			expect(known, `${method} ${path}`).toBe(true);
		}
	});

	it('is a 3.1 document with the standard parts', () => {
		const committed = JSON.parse(readFileSync(OUTPUT, 'utf8')) as Json;
		expect(committed.openapi).toBe('3.1.0');
		expect(Object.keys(committed.components.securitySchemes)).toEqual(['session', 'apiKey']);
	});
});

describe('gen-openapi: live route tree', () => {
	it('documents one operation for every live route, with its action', async () => {
		const { routes } = await scanRoutes(API_ROOT);
		const doc = JSON.parse(await renderOpenApi(API_ROOT)) as Json;
		expect(operations(doc)).toHaveLength(routes.length);
		for (const route of routes) {
			const op = doc.paths[route.path]?.[route.method];
			expect(op, `${route.method} ${route.path}`).toBeDefined();
			expect(op['x-action'], `${route.method} ${route.path}`).toBe(route.meta.action);
		}
	});

	it('documents the capacity route with its action and a 200 response', async () => {
		const doc = JSON.parse(await renderOpenApi(API_ROOT)) as Json;
		const op = doc.paths['/api/v1/admin/capacity']?.get;
		expect(op['x-action']).toBe('admin.capacity.read');
		expect(op.responses['200']).toBeDefined();
	});

	it('documents the repository connection and remote routes with their actions and success statuses', async () => {
		const committed = JSON.parse(readFileSync(OUTPUT, 'utf8')) as Json;
		const org = '/api/v1/orgs/{orgId}';
		const expected: [string, string, string, string][] = [
			[`${org}/repo-connections`, 'get', 'repo.read', '200'],
			[`${org}/repo-connections`, 'post', 'repo.connect', '200'],
			[`${org}/repo-connections/complete`, 'post', 'repo.connect', '201'],
			[`${org}/repo-connections/{id}/revoke`, 'post', 'repo.connect', '200'],
			[`${org}/repo-connections/{id}/repositories`, 'get', 'repo.read', '200'],
			[`${org}/sites/{id}/remotes`, 'post', 'site.remote.manage', '201'],
			[`${org}/sites/{id}/remotes`, 'get', 'site.read', '200']
		];
		for (const [path, method, action, status] of expected) {
			const op = committed.paths[path]?.[method];
			expect(op, `${method} ${path}`).toBeDefined();
			expect(op['x-action'], `${method} ${path}`).toBe(action);
			expect(op.responses[status], `${method} ${path}`).toBeDefined();
		}
		for (const [path, method, action] of expected) {
			if (isSessionOnly(action as never)) {
				expect(committed.paths[path][method].security, `${method} ${path}`).toEqual([
					{ session: [] }
				]);
			}
		}
	});

	it('leaves the signature-checked GitHub hook out, as it is not a defineApi route', async () => {
		const committed = JSON.parse(readFileSync(OUTPUT, 'utf8')) as Json;
		expect(Object.keys(committed.paths).filter((path) => path.includes('hooks'))).toEqual([]);
	});
});

describe('gen-openapi: sample routes', () => {
	it('is deterministic and sorted by path then method', async () => {
		expect(await renderOpenApi(FIXTURES)).toBe(sampleText);
		const order = operations(sample).map(({ method, path }) => `${method} ${path}`);
		expect(order).toEqual([
			'get /api/v1/admin/aggregates',
			'post /api/v1/auth/code',
			'get /api/v1/me',
			'post /api/v1/orgs/{orgId}/keys',
			'get /api/v1/orgs/{orgId}/members',
			'get /api/v1/sites/{id}',
			'delete /api/v1/sites/{id}',
			'post /api/v1/sites/{id}/deploys'
		]);
	});

	it('carries x-action and x-rate-class from the route meta, with a unique operation id', async () => {
		const { routes } = await scanRoutes(FIXTURES);
		const ids = new Set<string>();
		for (const { path, method, op } of operations(sample)) {
			const route = routes.find((r) => r.path === path && r.method === method);
			expect(route, `${method} ${path}`).toBeDefined();
			expect(op['x-action']).toBe(route!.meta.action);
			expect(op['x-rate-class']).toBe(route!.meta.rateClass);
			expect(op.summary).toBe(route!.meta.summary);
			expect(API_TAG_NAMES).toEqual(expect.arrayContaining(op.tags));
			ids.add(op.operationId);
		}
		expect(ids.size).toBe(routes.length);
		expect(sample.paths['/api/v1/sites/{id}'].get.operationId).toBe('getApiV1SitesId');
	});

	it('ties every x-action to the permission table', () => {
		for (const { op } of operations(sample)) {
			const public_ = op.security.length === 0;
			expect(public_ ? isPublicAction(op['x-action']) : isAction(op['x-action'])).toBe(true);
		}
	});

	it('declares the cookie and bearer schemes, and keys only where a key can act', () => {
		const schemes = sample.components.securitySchemes;
		expect(schemes.session).toMatchObject({ type: 'apiKey', in: 'cookie' });
		expect(schemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
		const security = (path: string, method: string) => sample.paths[path][method].security;
		expect(security('/api/v1/auth/code', 'post')).toEqual([]);
		expect(security('/api/v1/sites/{id}', 'get')).toEqual([{ session: [] }, { apiKey: [] }]);
		expect(security('/api/v1/orgs/{orgId}/keys', 'post')).toEqual([{ session: [] }]);
		expect(security('/api/v1/admin/aggregates', 'get')).toEqual([{ session: [] }]);
		for (const { op } of operations(sample)) {
			const action = op['x-action'];
			if (isAction(action) && isSessionOnly(action))
				expect(op.security).toEqual([{ session: [] }]);
		}
	});

	it('turns params, query, body and response schemas into parameters and content', () => {
		const get = sample.paths['/api/v1/sites/{id}'].get;
		expect(get.parameters).toEqual([
			{ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
			{
				name: 'expand',
				in: 'query',
				required: false,
				schema: { type: 'string', enum: ['config'] }
			},
			{ $ref: '#/components/parameters/ContractHeader' }
		]);
		expect(get.responses['200'].content['application/json'].schema).toMatchObject({
			type: 'object',
			required: ['id', 'name', 'expanded']
		});
		const deploy = sample.paths['/api/v1/sites/{id}/deploys'].post;
		expect(deploy.requestBody).toMatchObject({
			required: true,
			content: { 'application/json': { schema: { required: ['ref'] } } }
		});
		expect(Object.keys(deploy.responses)).toContain('202');
		expect(deploy.parameters).toContainEqual({
			$ref: '#/components/parameters/IdempotencyKey'
		});
		expect(get.parameters).not.toContainEqual({
			$ref: '#/components/parameters/IdempotencyKey'
		});
	});

	it('gives a 204 route no content, and lists the standard error responses by route kind', () => {
		const del = sample.paths['/api/v1/sites/{id}'].delete;
		expect(del.responses['204'].content).toBeUndefined();
		expect(Object.keys(del.responses)).toEqual([
			'204',
			'400',
			'401',
			'403',
			'404',
			'422',
			'426',
			'429',
			'500'
		]);
		const open = sample.paths['/api/v1/auth/code'].post;
		expect(Object.keys(open.responses)).toEqual(['202', '400', '422', '426', '429', '500']);
		const me = sample.paths['/api/v1/me'].get;
		expect(Object.keys(me.responses)).toEqual(['200', '401', '403', '426', '429', '500']);
	});

	it('documents the rate-limit and contract headers on success, errors and 429', () => {
		const ok = sample.paths['/api/v1/me'].get.responses['200'];
		for (const name of [
			'RateLimit-Limit',
			'RateLimit-Remaining',
			'RateLimit-Reset',
			'Drupflare-Contract',
			'X-Request-Id'
		]) {
			expect(ok.headers, name).toHaveProperty([name]);
		}
		const limited = sample.components.responses.RateLimited;
		expect(limited.headers['Retry-After']).toEqual({ $ref: '#/components/headers/RetryAfter' });
		expect(sample.components.parameters.ContractHeader).toMatchObject({
			name: 'Drupflare-Contract',
			in: 'header',
			required: false
		});
	});

	it('shares the contract error envelope and every $ref resolves', () => {
		const wire = { code: 'validation', message: 'x', details: {}, requestId: 'req_1' };
		expect(errorEnvelope.safeParse(wire).success).toBe(true);
		const { $schema: _dialect, ...envelope } = z.toJSONSchema(errorEnvelope) as Json;
		expect(sample.components.schemas.Error).toEqual(envelope);
		const all = refs(sample);
		expect(all.length).toBeGreaterThan(20);
		for (const pointer of all) expect(resolve(sample, pointer), pointer).toBeDefined();
	});

	it('writes no dialect or definitions keys inside the document', () => {
		expect(sampleText).not.toContain('"$schema"');
		expect(sampleText).not.toContain('"$defs"');
	});

	it('matches the idempotency key rule the pipeline enforces', () => {
		const { pattern } = sample.components.parameters.IdempotencyKey.schema as {
			pattern: string;
		};
		const samples = [
			'short',
			'key-12345678',
			'a'.repeat(128),
			'a'.repeat(129),
			'has space 1234',
			'ok_ok-ok_9'
		];
		for (const text of samples) {
			const accepted = thrownBy(() => parseIdempotencyKey(text)) === undefined;
			expect(new RegExp(pattern).test(text), text).toBe(accepted);
		}
	});

	it('shares one brand with defineApi', () => {
		expect(HANDLER_BRAND).toBe(API_HANDLER);
	});

	it('fails with every problem listed when a route file breaks a rule', async () => {
		const error = await renderOpenApi(BAD_FIXTURES).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('route scan failed');
		expect((error as Error).message).toContain('site.explode');
		expect((error as Error).message).toContain('params must match the path');
	});
});
