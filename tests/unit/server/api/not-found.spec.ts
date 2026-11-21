import { describe, expect, it } from 'vitest';
import notFound from '../../../../src/server/api/[...]';
import { send } from '../fixtures/harness';

describe('unrouted api paths', () => {
	it('answers the error envelope with 404 and no store', async () => {
		const reply = await send(notFound, '/api/**', { path: '/api/v1/nothing/here' });
		expect(reply.status).toBe(404);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(reply.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/);
		expect(reply.json).toMatchObject({
			code: 'not_found',
			message: 'Not found',
			requestId: reply.headers.get('x-request-id')
		});
	});

	it('answers a write the same way as a read', async () => {
		const reply = await send(notFound, '/api/**', { method: 'POST', path: '/api/v9/x' });
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
	});
});
