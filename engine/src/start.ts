import type { Workflow } from '@cloudflare/workers-types';
import {
	MAX_START_BYTES,
	START_HEADERS,
	START_REFUSAL_STATUS,
	secretUsable,
	verifyEvent,
	verifyStart,
	type StartRefusal,
	type WorkflowName
} from '@contracts/engine-start';

export * from '@contracts/engine-start';

const encoder = new TextEncoder();

// never lets a Workflow of any params type fit here
export type WorkflowStarter = Pick<Workflow<never>, 'create' | 'get'>;

const refuse = (code: StartRefusal) =>
	Response.json({ ok: false, code }, { status: START_REFUSAL_STATUS[code] });

// the request id is the instance id of a running workflow, which gets the event it waits for
async function deliverEvent(
	request: Request,
	body: string,
	options: { secret: string; now: number; workflows: Record<WorkflowName, WorkflowStarter> }
): Promise<Response> {
	const verdict = await verifyEvent(request.headers, body, options);
	if (!verdict.ok) return refuse(verdict.code);
	if (request.method !== 'POST') return refuse('wrong_method');
	const { workflow, id, type, payload } = verdict.value;
	try {
		const instance = await options.workflows[workflow].get(id);
		await instance.sendEvent({ type, payload });
	} catch {
		return refuse('not_running');
	}
	return Response.json({ ok: true, workflow, id, type }, { status: 202 });
}

// the request id becomes the workflow instance id, which the platform keeps unique per workflow
export async function handleStart(
	request: Request,
	options: {
		secret: string;
		now: number;
		workflows: Record<WorkflowName, WorkflowStarter>;
	}
): Promise<Response> {
	if (Object.values(START_HEADERS).some((name) => request.headers.get(name) === null)) {
		return refuse('unsigned');
	}
	if (!secretUsable(options.secret)) return refuse('unconfigured');
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > MAX_START_BYTES) return refuse('too_large');
	const body = await request.text();
	if (encoder.encode(body).byteLength > MAX_START_BYTES) return refuse('too_large');
	const { pathname } = new URL(request.url);
	if (pathname === '/event') return deliverEvent(request, body, options);
	const verdict = await verifyStart(request.headers, body, options);
	if (!verdict.ok) return refuse(verdict.code);
	if (pathname !== '/start') return refuse('unknown_path');
	if (request.method !== 'POST') return refuse('wrong_method');
	const { workflow, id, params } = verdict.value;
	const starter = options.workflows[workflow];
	try {
		// the signed caller built the params; the workflow's own run reads them as its input type
		await starter.create({ id, params: params as never });
	} catch (error) {
		const existing = await starter.get(id).then(
			() => true,
			() => false
		);
		if (existing) return refuse('replayed');
		throw error;
	}
	return Response.json({ ok: true, workflow, id }, { status: 202 });
}
