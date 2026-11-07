import {
	assetsApi,
	LimitError,
	NotFoundError,
	readRateHeaders,
	Routing,
	type DispatchPlane,
	type Migration,
	type Resources
} from '@drupflare/workforce';
import { RateLimitedError } from '../account-usage';
import type { Cloudflare } from '../ports';
import { PermanentError } from '../step';
import { multipartBody } from '../stream-body';

const encoder = new TextEncoder();

// the upload endpoints answer the usual envelope; a refusal names the reason the API gave
async function readUpload(response: Response, what: string): Promise<unknown> {
	let body: {
		success?: boolean;
		result?: unknown;
		errors?: { message?: string; code?: unknown }[];
	};
	try {
		body = await response.json();
	} catch {
		throw new Error(`${what}: HTTP ${response.status} with a non-JSON body`);
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error(`${what}: HTTP ${response.status}, the credential was rejected`);
	}
	if (body.success === false || body.result === undefined) {
		const detail = (body.errors ?? []).map((e) => e.message ?? String(e.code)).join('; ');
		throw new Error(
			`${what} was refused: ${detail === '' ? `HTTP ${response.status}` : detail}`
		);
	}
	return body.result;
}

// the upload API takes one stepped object where a wrangler config lists tagged migrations, and
// workforce types and sends the list as given. A first upload has no old tag to start after; an
// update names the tag the script is at, sends only the steps after it, and sends nothing when
// the script is already at the last tag
export function steppedMigrations(
	migrations: readonly Migration[],
	oldTag?: string
): Migration[] | undefined {
	const last = migrations[migrations.length - 1];
	if (last === undefined) return undefined;
	const strip = (list: readonly Migration[]) => list.map(({ tag: _tag, ...step }) => step);
	if (oldTag === undefined) {
		return { new_tag: last.tag, steps: strip(migrations) } as unknown as Migration[];
	}
	if (oldTag === last.tag) return undefined;
	const at = migrations.findIndex((migration) => migration.tag === oldTag);
	if (at < 0) {
		throw new PermanentError(
			'migration_tag_unknown',
			`the script is at migration ${oldTag}, which the upload does not list`
		);
	}
	return {
		old_tag: oldTag,
		new_tag: last.tag,
		steps: strip(migrations.slice(at + 1))
	} as unknown as Migration[];
}

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
			if (!upload.modules.some(({ module }) => module.name === upload.main)) {
				throw new PermanentError(
					'upload_main_missing',
					`the entry point ${upload.main} is not in the module set`
				);
			}
			const { migrations, ...rest } = upload.metadata;
			const stepped =
				migrations === undefined ? undefined : steppedMigrations(migrations, upload.oldTag);
			const metadata = {
				...(stepped === undefined ? rest : { ...rest, migrations: stepped }),
				main_module: upload.main
			};
			const form = multipartBody([
				{ name: 'metadata', bytes: encoder.encode(JSON.stringify(metadata)) },
				...upload.modules.map(({ module, bytes }) => ({
					name: module.name,
					filename: module.name,
					contentType: module.contentType,
					bytes
				}))
			]);
			const response = await paced(() =>
				plane.http.send(`${plane.base}/scripts/${name}`, {
					method: 'PUT',
					headers: { 'content-type': form.contentType },
					body: form.body
				})
			);
			await readUpload(response, `uploading ${name}`);
			return { versionId: null };
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

		async uploadAssetBucket(jwt, files) {
			const form = multipartBody(
				files.map((file) => ({
					name: file.hash,
					filename: file.hash,
					contentType: 'application/null',
					bytes: file.bytes,
					base64: true
				}))
			);
			const response = await paced(() =>
				plane.http.send(`${account}/workers/assets/upload`, {
					method: 'POST',
					query: { base64: true },
					headers: { authorization: `Bearer ${jwt}`, 'content-type': form.contentType },
					body: form.body
				})
			);
			const result = await readUpload(response, 'uploading an asset bucket');
			return String((result as { jwt?: unknown }).jwt ?? '');
		}
	};
}
