import {
	MAX_START_BYTES,
	START_REFUSALS,
	secretUsable,
	signEvent,
	signStart,
	startIdPattern,
	type StartRefusal,
	type WorkflowName
} from '@contracts/engine-start';
import { ApiError } from '../../shared/errors';

export interface EngineBinding {
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface EngineStartRequest {
	workflow: WorkflowName;
	// the operation id; the engine uses it as the workflow instance id
	id: string;
	params: Record<string, unknown>;
}

export type EngineStartErrorCode = StartRefusal | 'invalid_id' | 'unavailable' | 'rejected';

export class EngineStartError extends Error {
	readonly code: EngineStartErrorCode;

	constructor(code: EngineStartErrorCode, message: string) {
		super(message);
		this.name = 'EngineStartError';
		this.code = code;
	}
}

export interface EngineConfig {
	binding: EngineBinding | undefined;
	secret: string | undefined;
	now: () => number;
}

const isBinding = (value: unknown): value is EngineBinding =>
	typeof (value as { fetch?: unknown } | undefined)?.fetch === 'function';

export function engineConfigOf(env: Record<string, unknown>): Omit<EngineConfig, 'now'> {
	const secret = env.START_SECRET;
	return {
		binding: isBinding(env.ENGINE) ? env.ENGINE : undefined,
		secret: typeof secret === 'string' && secret !== '' ? secret : undefined
	};
}

export interface EngineEventRequest {
	workflow: WorkflowName;
	// the operation id of the running workflow
	id: string;
	type: string;
	payload: Record<string, unknown>;
}

const REFUSALS: readonly string[] = START_REFUSALS;

async function refusalOf(response: Response): Promise<StartRefusal | null> {
	try {
		const body = (await response.json()) as { code?: unknown };
		return typeof body.code === 'string' && REFUSALS.includes(body.code)
			? (body.code as StartRefusal)
			: null;
	} catch {
		return null;
	}
}

// resolves once the engine has accepted the start; it never waits for the workflow to run
export function engineStarter(
	config: EngineConfig
): (request: EngineStartRequest) => Promise<void> {
	return async (request) => {
		const { binding, secret } = config;
		if (binding === undefined || !secretUsable(secret)) {
			throw new ApiError('not_built', 'The engine is not available yet');
		}
		if (!startIdPattern.test(request.id)) {
			throw new EngineStartError('invalid_id', 'the operation id cannot be a start id');
		}
		const body = JSON.stringify({ workflow: request.workflow, params: request.params });
		if (new TextEncoder().encode(body).byteLength > MAX_START_BYTES) {
			throw new EngineStartError('too_large', 'the start request is over the size limit');
		}
		const headers = await signStart(body, { secret, now: config.now(), id: request.id });
		let response: Response;
		try {
			response = await binding.fetch('https://engine/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body
			});
		} catch {
			throw new EngineStartError('unavailable', 'the engine did not answer');
		}
		if (response.status === 202) return;
		const code = await refusalOf(response);
		// a replay means this operation already started
		if (code === 'replayed') return;
		if (code !== null) {
			throw new EngineStartError(code, `the engine refused the start: ${code}`);
		}
		throw new EngineStartError(
			response.status >= 500 ? 'unavailable' : 'rejected',
			`the engine answered ${response.status}`
		);
	};
}

// resolves once the engine has handed the event to a running workflow; refused when none is waiting
export function engineEventSender(
	config: EngineConfig
): (request: EngineEventRequest) => Promise<void> {
	return async (request) => {
		const { binding, secret } = config;
		if (binding === undefined || !secretUsable(secret)) {
			throw new ApiError('not_built', 'The engine is not available yet');
		}
		if (!startIdPattern.test(request.id)) {
			throw new EngineStartError('invalid_id', 'the operation id cannot be a start id');
		}
		const body = JSON.stringify({
			workflow: request.workflow,
			type: request.type,
			payload: request.payload
		});
		const headers = await signEvent(body, { secret, now: config.now(), id: request.id });
		let response: Response;
		try {
			response = await binding.fetch('https://engine/event', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body
			});
		} catch {
			throw new EngineStartError('unavailable', 'the engine did not answer');
		}
		if (response.status === 202) return;
		const code = await refusalOf(response);
		if (code !== null) {
			throw new EngineStartError(code, `the engine refused the event: ${code}`);
		}
		throw new EngineStartError(
			response.status >= 500 ? 'unavailable' : 'rejected',
			`the engine answered ${response.status}`
		);
	};
}
