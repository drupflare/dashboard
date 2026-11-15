import {
	defineEventHandler,
	getRequestHeader,
	setResponseHeader,
	setResponseStatus,
	type H3Event
} from 'h3';
import { ERROR_STATUS } from '../../../shared/errors';
import { acceptReleaseEvent, releaseServices } from '../../services/releases';
import { toErrorBody } from '../../utils/errors';
import { readCappedBody } from '../../utils/request';

const MAX_BODY_BYTES = 64 * 1024;

function reply(event: H3Event, status: number, body: unknown): string {
	setResponseStatus(event, status);
	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return JSON.stringify(body);
}

// signature-checked, so it sits outside defineApi: the sender holds no session or key
export default defineEventHandler(async (event) => {
	const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
	try {
		const services = releaseServices();
		const rawBody = await readCappedBody(event, MAX_BODY_BYTES);
		const result = await acceptReleaseEvent(services, {
			rawBody,
			signature: getRequestHeader(event, 'x-drupflare-signature') ?? null
		});
		return reply(event, 200, { received: true, ...result });
	} catch (error) {
		const body = toErrorBody(error, requestId);
		if (body.code === 'internal') console.error(requestId, error);
		return reply(event, ERROR_STATUS[body.code], body);
	}
});
