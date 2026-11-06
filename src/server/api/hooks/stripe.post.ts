import {
	defineEventHandler,
	getRequestHeader,
	setResponseHeader,
	setResponseStatus,
	type H3Event
} from 'h3';
import { ERROR_STATUS } from '../../../shared/errors';
import { billingServices, processWebhook } from '../../services/billing';
import { toErrorBody } from '../../utils/errors';
import { readCappedBody } from '../../utils/request';

const MAX_BODY_BYTES = 1024 * 1024;

function reply(event: H3Event, status: number, body: unknown): string {
	setResponseStatus(event, status);
	setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return JSON.stringify(body);
}

// signature-checked, so it sits outside defineApi: stripe sends no session or key
export default defineEventHandler(async (event) => {
	const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
	try {
		const services = billingServices();
		const rawBody = await readCappedBody(event, MAX_BODY_BYTES);
		const result = await processWebhook(
			services,
			rawBody,
			getRequestHeader(event, 'stripe-signature') ?? null
		);
		return reply(event, result.status, result.body);
	} catch (error) {
		const body = toErrorBody(error, requestId);
		// a failed handler answers 500 so stripe retries the event
		if (body.code === 'internal') console.error(requestId, error);
		return reply(event, ERROR_STATUS[body.code], body);
	}
});
