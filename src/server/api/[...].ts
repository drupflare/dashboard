import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3';
import { ApiError } from '../../shared/errors';
import { toErrorBody } from '../utils/errors';

// the fallback for any /api path no route owns; it answers the same envelope as a routed error
export default defineEventHandler((event) => {
	const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
	setResponseStatus(event, 404);
	setResponseHeader(event, 'X-Request-Id', requestId);
	setResponseHeader(event, 'Cache-Control', 'no-store');
	return toErrorBody(new ApiError('not_found', 'Not found'), requestId);
});
