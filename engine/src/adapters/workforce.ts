import {
	assetsApi,
	LimitError,
	MODULE_CONTENT_TYPE,
	NotFoundError,
	readRateHeaders,
	Routing,
	WorkerHandle,
	type DispatchPlane,
	type ModuleType,
	type Resources
} from '@drupflare/workforce';
import { RateLimitedError } from '../account-usage';
import type { Cloudflare } from '../ports';

const TYPE_OF_CONTENT = Object.fromEntries(
	Object.entries(MODULE_CONTENT_TYPE).map(([type, content]) => [content, type as ModuleType])
);

// workforce's delete methods send the request and never read the status, so a refused delete would
// look like a success; this reads it
async function checkedDelete(
	plane: DispatchPlane,
	path: string,
	query?: Record<string, string | number | boolean>
): Promise<'deleted' | 'absent'> {
	const response = await plane.http.send(path, { method: 'DELETE', query });
	if (response.status === 404) return 'absent';
	if (!response.ok) throw new Error(`DELETE ${path} answered ${response.status}`);
	return 'deleted';
}

// a rate limit is worth retrying after the wait the response named
async function paced<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof LimitError)
			throw new RateLimitedError(error.message, error.retryAfterMs);
		throw error;
	}
}

export function workforceCloudflare(plane: DispatchPlane, resources: Resources): Cloudflare {
	const account = `/accounts/${plane.accountId}`;
	const routing = new Routing(plane.http, plane.accountId);

	async function listResources(kind: 'kv' | 'r2' | 'd1') {
		if (kind === 'kv') {
			return (await resources.listKv()).map((item) => ({ id: item.id, name: item.title }));
		}
		if (kind === 'r2') {
			return (await resources.listR2()).map((item) => ({ id: item.name, name: item.name }));
		}
		return (await resources.listD1()).map((item) => ({ id: item.uuid, name: item.name }));
	}

	return {
		listResources: (kind) => paced(() => listResources(kind)),

		// workforce's dispatch get tests the error's name, which the bundle renamed, so it throws
		// instead of returning null
		// the namespace answers 200 with a null script for a name that is not there, so a missing script
		// never reaches workforce's 404 handling
		async getScript(name) {
			const probe = await paced(() =>
				plane.http.send(`${plane.base}/scripts/${encodeURIComponent(name)}`)
			);
			if (probe.status === 404) return null;
			if (!probe.ok) throw new Error(`GET a script answered ${probe.status}`);
			const body = (await probe.json()) as { result?: { script?: unknown } | null };
			if (body.result?.script == null) return null;
			try {
				const found = await paced(() => plane.get(name));
				return found === null ? null : { tags: found.tags, version: found.modifiedOn };
			} catch (error) {
				if (error instanceof NotFoundError) return null;
				throw error;
			}
		},

		async listRoutes(zoneId) {
			const routes = await paced(() => routing.routes(zoneId));
			return routes.map((route) => ({
				id: route.id,
				zoneId,
				pattern: route.pattern,
				script: route.script
			}));
		},

		// counts come from the listings; the headroom comes from the headers of one more small read
		async readUsage() {
			const kvNamespaces = (await paced(() => resources.listKv())).length;
			const buckets = (await paced(() => resources.listR2())).length;
			const response = await paced(() =>
				plane.http.send(`${account}/storage/kv/namespaces`, { query: { per_page: 5 } })
			);
			return { kvNamespaces, buckets, rate: readRateHeaders(response.headers) };
		},

		async findResource(kind, name) {
			const found = (await paced(() => listResources(kind))).find(
				(item) => item.name === name
			);
			return found === undefined ? null : { providerId: found.id };
		},

		async createResource(kind, name) {
			return paced(async () => {
				if (kind === 'kv') return { providerId: (await resources.createKv(name)).id };
				if (kind === 'r2') return { providerId: (await resources.createR2(name)).name };
				return { providerId: (await resources.createD1(name)).uuid };
			});
		},

		deleteResource(kind, providerId) {
			if (kind === 'kv') {
				return checkedDelete(plane, `${account}/storage/kv/namespaces/${providerId}`);
			}
			if (kind === 'r2') return checkedDelete(plane, `${account}/r2/buckets/${providerId}`);
			return checkedDelete(plane, `${account}/d1/database/${providerId}`);
		},

		async addRoute(zoneId, pattern, script) {
			const route = await paced(() => routing.addRoute(zoneId, pattern, script));
			return { providerId: route.id };
		},

		removeRoute: (zoneId, routeId) =>
			checkedDelete(plane, `/zones/${zoneId}/workers/routes/${routeId}`),

		async putScript(name, upload) {
			const source = new Map(upload.modules.map(({ module, bytes }) => [module.name, bytes]));
			const types = Object.fromEntries(
				upload.modules.flatMap(({ module }) => {
					const type = TYPE_OF_CONTENT[module.contentType];
					return type === undefined ? [] : [[module.name, type]];
				})
			);
			const result = await paced(() =>
				new WorkerHandle(plane, name).upload({
					source,
					main: upload.main,
					types,
					metadata: upload.metadata
				})
			);
			return { versionId: result.versionId };
		},

		deleteScript: (name) =>
			checkedDelete(plane, `${plane.base}/scripts/${name}`, { force: true }),

		startAssetSession(script, manifest) {
			return paced(() =>
				assetsApi(
					plane.http,
					plane.accountId,
					`${plane.base}/scripts/${script}/assets-upload-session`
				).startSession(manifest)
			);
		},

		uploadAssetBucket(jwt, files) {
			// the bucket upload path does not depend on the session path
			return paced(() => assetsApi(plane.http, plane.accountId, '').uploadBucket(jwt, files));
		}
	};
}
