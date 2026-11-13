import { z } from 'zod';
import type { ChangeManifest, MarkIncomplete, WriteMarkWorker } from '../ports';
import { PermanentError } from '../step';
import { SiteAnswered, SiteUnreachable, siteFetcher } from './site';

const reason = z.enum(['journal_full', 'capture_failed']);

const countAnswer = z.looseObject({
	mark: z.string(),
	writes: z.number().int().nonnegative(),
	incomplete: z.boolean(),
	reason: reason.optional()
});

const manifestAnswer = countAnswer.extend({
	through: z.number().int().nonnegative(),
	cannotCarry: z.array(z.string())
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function safeJson(text: string | null): unknown {
	try {
		return JSON.parse(text ?? '');
	} catch {
		return null;
	}
}

// a site that has the route answers 404 with this body when no mark is active; a site that does
// not have it hands the request to Drupal, which answers its own page
function routeAnswered(text: string | null): boolean {
	const body = safeJson(text) as { ok?: unknown; error?: unknown } | null;
	return (
		body !== null &&
		typeof body === 'object' &&
		body.ok === false &&
		typeof body.error === 'string'
	);
}

function refusedToken(status: number): void {
	if (status === 401 || status === 403) {
		throw new PermanentError('owner_token_rejected', 'the site refused the owner token');
	}
}

function parsed<T>(text: string | null, schema: z.ZodType<T>, what: string): T {
	const checked = schema.safeParse(safeJson(text));
	if (!checked.success) throw new Error(`${what} was not readable`);
	return checked.data;
}

const incompleteOf = (data: {
	incomplete: boolean;
	reason?: MarkIncomplete;
}): MarkIncomplete | null => (data.incomplete ? (data.reason ?? 'capture_failed') : null);

const markPath = (mark: string) => `/writemark?mark=${encodeURIComponent(mark)}`;

// the owner routes that count the writes a site accepts and export what changed
export function writeMarkWorkerOf(fetcher: typeof fetch, timeoutMs: number): WriteMarkWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	const readAnswers = (code: number) =>
		code === 200 || code === 201 || code === 404 || code === 409;

	return {
		async supported(hostname, auth) {
			const { status, text } = await fetchSite(
				hostname,
				'/writemark',
				{ method: 'GET', headers: bearer(auth.bearer) },
				readAnswers
			);
			refusedToken(status);
			if (status === 200) return true;
			if (status === 404) return routeAnswered(text);
			if (status === 501) return false;
			throw new SiteAnswered(hostname, '/writemark', status);
		},

		async start(hostname, mark, auth) {
			const path = markPath(mark);
			const { status, text } = await fetchSite(
				hostname,
				path,
				{ method: 'POST', headers: bearer(auth.bearer) },
				readAnswers
			);
			refusedToken(status);
			if (status === 201) return 'started';
			if (status === 200) return 'existing';
			if (status === 409) {
				const body = safeJson(text) as { active?: unknown } | null;
				// a replica lane refuses without naming a mark, and the step tries again
				if (body !== null && typeof body === 'object' && body.active !== undefined) {
					return 'taken';
				}
				throw new SiteAnswered(hostname, '/writemark', status);
			}
			if (status === 404 || status === 501) return 'missing';
			throw new SiteAnswered(hostname, '/writemark', status);
		},

		async read(hostname, auth) {
			const { status, text } = await fetchSite(
				hostname,
				'/writemark',
				{ method: 'GET', headers: bearer(auth.bearer) },
				readAnswers
			);
			refusedToken(status);
			if (status === 200) {
				const data = parsed(text, countAnswer, 'the write count');
				return { mark: data.mark, writes: data.writes, incomplete: incompleteOf(data) };
			}
			if (status === 404) return routeAnswered(text) ? 'none' : 'missing';
			if (status === 501) return 'missing';
			throw new SiteAnswered(hostname, '/writemark', status);
		},

		async end(hostname, mark, auth) {
			const { status } = await fetchSite(
				hostname,
				markPath(mark),
				{ method: 'DELETE', headers: bearer(auth.bearer) },
				() => false
			);
			refusedToken(status);
			// 409 names another mark and 404 or 501 a site without the routes: nothing of ours to end
			if (status === 200 || status === 409 || status === 404 || status === 501) return;
			throw new SiteAnswered(hostname, '/writemark', status);
		},

		async manifest(hostname, auth, through) {
			const query = `dialect=mysql${through === undefined ? '' : `&through=${through}`}`;
			const { status, text } = await fetchSite(
				hostname,
				`/writechanges?${query}`,
				{ method: 'GET', headers: bearer(auth.bearer) },
				readAnswers
			);
			refusedToken(status);
			if (status === 200) {
				const data = parsed(text, manifestAnswer, 'the change list');
				return {
					mark: data.mark,
					writes: data.writes,
					incomplete: incompleteOf(data),
					through: data.through,
					cannotCarry: data.cannotCarry
				} satisfies ChangeManifest;
			}
			if (status === 404) return routeAnswered(text) ? 'none' : 'missing';
			if (status === 501) return 'missing';
			throw new SiteAnswered(hostname, '/writechanges', status);
		},

		// not read through the shared fetcher, which holds a body whole
		async body(hostname, through, auth, since) {
			const path = `/writechanges?body=1&through=${through}&dialect=mysql${
				since === undefined ? '' : `&since=${since}`
			}`;
			const url = new URL(path, `https://${hostname}`);
			if (url.host !== hostname.toLowerCase() || url.protocol !== 'https:') {
				throw new PermanentError(
					'invalid_site_call',
					`${path} does not stay on ${hostname}`
				);
			}
			let response: Response;
			try {
				response = await fetcher(url, {
					method: 'GET',
					headers: bearer(auth.bearer),
					redirect: 'manual',
					signal: AbortSignal.timeout(timeoutMs)
				});
			} catch (error) {
				throw new SiteUnreachable(hostname, error);
			}
			const { status } = response;
			if (status !== 200 || response.body === null) {
				await response.body?.cancel();
				refusedToken(status);
				if (status === 404) {
					throw new PermanentError(
						'write_count_lost',
						'the site no longer has the count'
					);
				}
				throw new SiteAnswered(hostname, '/writechanges', status);
			}
			const flag = response.headers.get('x-cfw-incomplete');
			const header = Number(response.headers.get('x-cfw-through'));
			const startsAfter = response.headers.get('x-cfw-since');
			return {
				stream: response.body,
				through: Number.isSafeInteger(header) ? header : -1,
				since:
					startsAfter !== null && Number.isSafeInteger(Number(startsAfter))
						? Number(startsAfter)
						: -1,
				incomplete: flag === null || flag === 'no' ? null : reasonOf(flag)
			};
		}
	};
}

const reasonOf = (value: string): MarkIncomplete =>
	value === 'journal_full' ? 'journal_full' : 'capture_failed';
