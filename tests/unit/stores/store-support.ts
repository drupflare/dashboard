import { registerEndpoint } from '@nuxt/test-utils/runtime';
import { defineEventHandler, getQuery, getRequestHeaders, readBody, setResponseStatus } from 'h3';

export type Reply = { status?: number; body: unknown };
export type Call = {
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string | undefined>;
	body: unknown;
};
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);

export const calls: Call[] = [];

// keys are `METHOD /api/v1/path`; every request reaches a registered Nitro endpoint
export function registerApi(routes: Record<string, Route>): () => void {
	const cleanups = Object.entries(routes).map(([key, route]) => {
		const [method, path] = key.split(' ') as [string, string];
		return registerEndpoint(path, {
			method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
			handler: defineEventHandler(async (event) => {
				const call: Call = {
					method,
					path,
					query: getQuery(event) as Record<string, string>,
					headers: getRequestHeaders(event),
					body:
						method === 'POST' || method === 'PATCH' || method === 'DELETE'
							? await readBody(event)
							: undefined
				};
				calls.push(call);
				const reply = await (typeof route === 'function' ? route(call) : route);
				setResponseStatus(event, reply.status ?? 200);
				// undefined means unhandled to the test-utils router, which answers 404
				return reply.body ?? null;
			})
		});
	});
	return () => cleanups.forEach((cleanup) => cleanup());
}

export function cookieValue(name: string): string | null {
	const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
	return match?.[1] ?? null;
}

export function clearBrowserState(): void {
	calls.length = 0;
	document.cookie = 'drupflare_org=; max-age=0; path=/';
	document.cookie = 'drupflare_in=; max-age=0; path=/';
	sessionStorage.clear();
}

export const failure = (code: string, message: string, requestId: string) => ({
	status: 500,
	body: { code, message, details: {}, requestId }
});
