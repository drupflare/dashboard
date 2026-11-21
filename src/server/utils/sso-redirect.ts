import { ApiError } from '../../shared/errors';
import type { SsoFailure } from '../../shared/sso';
import { SsoError } from '../domain/sso';

function failureOf(error: unknown): SsoFailure {
	if (error instanceof SsoError) {
		if (error.code === 'domain') return 'domain';
		if (error.code === 'unverified') return 'unverified';
		return 'failed';
	}
	if (error instanceof ApiError) {
		const reason = (error.details as { reason?: string } | undefined)?.reason;
		if (reason === 'disabled' || reason === 'unknown') return reason;
		if (error.code === 'not_built') throw error;
		return 'failed';
	}
	throw error;
}

// the browser, not a script, calls these routes, so a refusal goes back to the sign-in page
export function ssoFailureRedirect(error: unknown): Response {
	const code = failureOf(error);
	return new Response(null, {
		status: 302,
		headers: { location: `/login?sso=${code}`, 'cache-control': 'no-store' }
	});
}
