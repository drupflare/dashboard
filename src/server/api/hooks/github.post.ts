import {
	defineEventHandler,
	getRequestHeader,
	setResponseHeader,
	setResponseStatus,
	type H3Event
} from 'h3';
import { ERROR_STATUS } from '../../../shared/errors';
import { acceptDelivery, repoConnectionDeps } from '../../services/repo-connections';
import { toErrorBody } from '../../utils/errors';
import { readCappedBody } from '../../utils/request';

// a push lists up to 2048 commits with their files, so the cap sits well above a normal body
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function reply(event: H3Event, status: number, body: unknown): string {
	setResponseStatus(event, status);
	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return JSON.stringify(body);
}

// signature-checked, so it sits outside defineApi: GitHub sends no session or key
export default defineEventHandler(async (event) => {
	const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
	try {
		const deps = repoConnectionDeps();
		const rawBody = await readCappedBody(event, MAX_BODY_BYTES);
		const result = await acceptDelivery(deps, 'github', {
			eventName: getRequestHeader(event, 'x-github-event') ?? null,
			deliveryId: getRequestHeader(event, 'x-github-delivery') ?? '',
			rawBody,
			signature: getRequestHeader(event, 'x-hub-signature-256') ?? null
		});
		return reply(event, 200, { received: true, ...result });
	} catch (error) {
		const body = toErrorBody(error, requestId);
		// a failed handler answers 500 so the delivery can be redelivered from GitHub
		if (body.code === 'internal') console.error(requestId, error);
		return reply(event, ERROR_STATUS[body.code], body);
	}
});
