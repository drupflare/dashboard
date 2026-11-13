import { PermanentError } from '../step';

export type SshFailure = 'auth' | 'timeout' | 'dns' | 'refused' | 'protocol' | 'unknown';

export interface SshDiagnosis {
	code: SshFailure;
	message: string;
}

// fixed text, so nothing a server or the library says can reach an owner or a log
const MESSAGES: Record<SshFailure, string> = {
	auth: 'The server did not accept the key. Add the public line to the authorized keys of that user, then try again.',
	timeout:
		'The server did not answer in time. Check that it is online and that the port is open.',
	dns: 'The address could not be found. Check the host name.',
	refused: 'The server refused the connection. Check the port and that SSH is running.',
	protocol: 'The server and Drupflare could not agree on how to connect.',
	unknown: 'The connection failed.'
};

// ported from the way a training host tells these apart: by the error name first, then by its text
export function classifySshError(error: unknown): SshDiagnosis {
	const name = (error as { name?: string } | null)?.name ?? '';
	const text = ((error as { message?: string } | null)?.message ?? String(error)).toLowerCase();
	const code = ((): SshFailure => {
		if (name === 'AuthError' || /auth|publickey|password|permission denied/.test(text)) {
			return 'auth';
		}
		if (name === 'TimeoutError' || /timeout|timed out/.test(text)) return 'timeout';
		if (/getaddrinfo|dns|enotfound|name not known|resolve/.test(text)) return 'dns';
		if (/refused|econnrefused|connect/.test(text)) return 'refused';
		if (name === 'ProtocolError' || /protocol|cipher|kex|host key/.test(text))
			return 'protocol';
		return 'unknown';
	})();
	return { code, message: MESSAGES[code] };
}

export const HOST_KEY_MISMATCH_MESSAGE =
	'the server host key is not the one confirmed, so nothing was run';

export const HOST_PRIVATE_MESSAGE =
	'the server address is not on the public internet, so nothing was run';
export const HOST_UNRESOLVED_MESSAGE = 'the server name could not be found, so nothing was run';

// a refusal that retrying cannot fix: the key was refused, or the server did not take the call
export function connectionRefusal(error: unknown): PermanentError {
	const { code, message } = classifySshError(error);
	return code === 'auth'
		? new PermanentError('source_auth_failed', message)
		: new PermanentError('source_unreachable', message);
}
