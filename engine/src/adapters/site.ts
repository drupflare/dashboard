import { z } from 'zod';
import { BackupError, parseExportPage } from '../backup-parts';
import { ConfigError } from '../config';
import { readFirstRunAdmin, readFirstRunSecrets, type FirstRunReads } from '../custody';
import type { BackupWorker, ImportState, Site } from '../ports';
import { PermanentError } from '../step';

// not a PermanentError, so the step retries it
export class SiteUnreachable extends Error {
	constructor(hostname: string, reason: unknown) {
		super(
			`${hostname} did not answer: ${reason instanceof Error ? reason.message : String(reason)}`
		);
		this.name = 'SiteUnreachable';
	}
}

// a status the step retries; the text names the route and the status and never a body
export class SiteAnswered extends Error {
	constructor(hostname: string, path: string, status: number) {
		super(`${hostname}${path} answered ${status}`);
		this.name = 'SiteAnswered';
	}
}

// a site that is still coming up can answer these: the route or script has not reached every colo
const COMING_UP = new Set([404, 408, 425, 429]);

// one line per call to a site: the route, the answer and how long it took, never a body, a header
// value other than the replay progress, or a query string
function logCall(
	hostname: string,
	path: string,
	status: number | 'no answer',
	ms: number,
	replay: string | null
): void {
	console.log(JSON.stringify({ event: 'engine.site-call', hostname, path, status, ms, replay }));
}

function siteFetcher(fetcher: typeof fetch, timeoutMs: number) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new ConfigError('SITE_TIMEOUT_MS');
	}
	return async (
		hostname: string,
		path: string,
		init: RequestInit,
		readWhen: (status: number) => boolean
	) => {
		const url = new URL(path, `https://${hostname}`);
		if (url.host !== hostname.toLowerCase() || url.protocol !== 'https:') {
			throw new PermanentError('invalid_site_call', `${path} does not stay on ${hostname}`);
		}
		let response: Response;
		const began = Date.now();
		try {
			response = await fetcher(url, {
				...init,
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch (error) {
			logCall(hostname, url.pathname, 'no answer', Date.now() - began, null);
			throw new SiteUnreachable(hostname, error);
		}
		const { status } = response;
		logCall(
			hostname,
			url.pathname,
			status,
			Date.now() - began,
			response.headers.get('x-cfw-migrate')
		);
		let text: string | null = null;
		if (readWhen(status)) {
			try {
				text = await response.text();
			} catch (error) {
				throw new SiteUnreachable(hostname, error);
			}
		} else {
			await response.body?.cancel();
		}
		return { status, text };
	};
}

const recoveredToken = z.looseObject({ ownerToken: z.string().min(1) });

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export function siteOf(fetcher: typeof fetch, timeoutMs: number): Site {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	// a status the caller handles itself comes back as an answer and not as a refusal
	const call = async (
		hostname: string,
		path: string,
		init: RequestInit,
		expectStatus: number | undefined,
		readBody = false,
		handled: readonly number[] = []
	) => {
		const accepted = (status: number) =>
			expectStatus === undefined ? status >= 200 && status < 300 : status === expectStatus;
		const { status, text } = await fetchSite(
			hostname,
			path,
			init,
			(code) => readBody && accepted(code)
		);
		if (
			status >= 400 &&
			status < 500 &&
			status !== expectStatus &&
			!COMING_UP.has(status) &&
			!handled.includes(status)
		) {
			throw new PermanentError('site_rejected', `${hostname}${path} answered ${status}`);
		}
		return { status, text };
	};
	return {
		probe: async (hostname, path, expectStatus, auth) => {
			const { status } = await call(
				hostname,
				path,
				{
					method: 'GET',
					...(auth === undefined
						? {}
						: { headers: { authorization: `Bearer ${auth.bearer}` } })
				},
				expectStatus
			);
			return { status };
		},
		firstRun: async (hostname, request) => {
			const reads: FirstRunReads | undefined = request.reads;
			const { status, text } = await call(
				hostname,
				request.path,
				{ method: request.method, body: request.body },
				request.expectStatus,
				reads !== undefined,
				// the claim is one-shot: 409 says an earlier call already ran it
				[409]
			);
			if (reads === undefined || text === null) return { status };
			return {
				status,
				secrets: readFirstRunSecrets(text, reads),
				admin: readFirstRunAdmin(text, reads)
			};
		},
		async recoverOwnerToken(hostname, nonce) {
			const { status, text } = await call(
				hostname,
				'/recover-token',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ nonce })
				},
				200,
				true,
				// KV may not have the record yet (404); the step retries
				[409, 410]
			);
			if (status !== 200 || text === null) return { status, ownerToken: null };
			const parsed = recoveredToken.safeParse(safeJson(text));
			return { status, ownerToken: parsed.success ? parsed.data.ownerToken : null };
		}
	};
}

// #region the owner routes a backup uses

const restoreAnswer = z.looseObject({ chunks: z.number().int(), statements: z.number().int() });
const healthAnswer = z.looseObject({
	import: z
		.looseObject({
			generation: z.string(),
			state: z.enum(['pending', 'applied', 'failed']),
			chunk: z.number().int().nullish(),
			chunks: z.number().int().nullish(),
			error: z.string().nullish()
		})
		.nullish()
});

const REASON_CHARS = 300;

// the site's own words for why an import stopped, bounded and with no control characters, since it
// is text from outside the engine that lands in an operation record
export function importReason(stored: {
	chunk?: number | null;
	chunks?: number | null;
	error?: string | null;
}): string {
	const where =
		stored.chunk != null && stored.chunks != null
			? `chunk ${stored.chunk} of ${stored.chunks}`
			: '';
	const why = (stored.error ?? '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.trim()
		.slice(0, REASON_CHARS);
	return [where, why].filter(Boolean).join(': ');
}
const statsAnswer = z.looseObject({
	storage: z.looseObject({ adopting: z.number().int().nonnegative() })
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// a refusal of the token is never retried: the worker counts failures against one budget
function refusedToken(status: number): void {
	if (status === 401 || status === 403) {
		throw new BackupError('owner_token_rejected', 'the site refused the owner token');
	}
}

function parseBody<T>(text: string | null, schema: z.ZodType<T>, what: string): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text ?? '');
	} catch {
		throw new Error(`${what} was not readable`);
	}
	const checked = schema.safeParse(parsed);
	if (!checked.success) throw new Error(`${what} was not readable`);
	return checked.data;
}

export function backupWorkerOf(fetcher: typeof fetch, timeoutMs: number): BackupWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	// the worker's /health reports the stored import, whichever label it carries
	const readImport = async (hostname: string, auth: { bearer: string }) => {
		const { status, text } = await fetchSite(
			hostname,
			'/health',
			{ method: 'GET', headers: bearer(auth.bearer) },
			(code) => code === 200
		);
		refusedToken(status);
		if (status !== 200) throw new SiteAnswered(hostname, '/health', status);
		return parseBody(text, healthAnswer, 'the health answer').import;
	};
	return {
		async exportPage(hostname, cursor, auth) {
			const path = `/export?cursor=${encodeURIComponent(cursor)}&body=1`;
			const { status, text } = await fetchSite(
				hostname,
				path,
				{ method: 'GET', headers: bearer(auth.bearer) },
				(code) => code === 200
			);
			refusedToken(status);
			if (status === 409) {
				throw new BackupError(
					'export_not_replayable',
					'the site answered that this dump cannot be replayed'
				);
			}
			if (status === 400) {
				throw new BackupError('export_unreadable', 'the site refused the export cursor');
			}
			if (status !== 200 || text === null)
				throw new SiteAnswered(hostname, '/export', status);
			return parseExportPage(text);
		},

		async restore(hostname, body, label, auth) {
			const path = `/restore?label=${encodeURIComponent(label)}`;
			const { status, text } = await fetchSite(
				hostname,
				path,
				// both lib sets accept a byte array as a body; only their typings disagree
				{ method: 'POST', headers: bearer(auth.bearer), body: body as unknown as BodyInit },
				(code) => code === 200
			);
			refusedToken(status);
			if (status === 413) {
				throw new BackupError(
					'restore_too_large',
					'the site refused the dump as too large'
				);
			}
			if (status >= 400 && status < 500 && !COMING_UP.has(status)) {
				throw new BackupError(
					'restore_rejected',
					`the site refused the restore (${status})`
				);
			}
			if (status !== 200) throw new SiteAnswered(hostname, '/restore', status);
			const { chunks, statements } = parseBody(text, restoreAnswer, 'the restore answer');
			return { chunks, statements };
		},

		// the worker's /health reports the stored import; an import under another label is not ours
		async importState(hostname, label, auth): Promise<ImportState> {
			const stored = await readImport(hostname, auth);
			return stored?.generation === label ? stored.state : 'absent';
		},

		async importReason(hostname, label, auth) {
			const stored = await readImport(hostname, auth);
			return stored?.generation === label ? importReason(stored) : '';
		},

		async adopting(hostname, auth) {
			const { status, text } = await fetchSite(
				hostname,
				'/serve-stats',
				{ method: 'GET', headers: bearer(auth.bearer) },
				(code) => code === 200
			);
			refusedToken(status);
			if (status !== 200) throw new SiteAnswered(hostname, '/serve-stats', status);
			return parseBody(text, statsAnswer, 'the stats answer').storage.adopting;
		}
	};
}

// #endregion
