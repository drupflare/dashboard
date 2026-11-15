import { z } from 'zod';
import type { OwnerAuth, PitrWorker } from '../ports';
import { PermanentError } from '../step';
import { SiteAnswered, siteFetcher } from './site';

const bearer = (auth: OwnerAuth) => ({ authorization: `Bearer ${auth.bearer}` });

const atAnswer = z.looseObject({ ok: z.literal(true), bookmark: z.string().min(1) });
const scheduledAnswer = z.looseObject({
	ok: z.literal(true),
	scheduled: z.string().min(1),
	undo: z.string().min(1)
});

function safeJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// the worker answers 501 with supported false when its storage keeps no change log, and 400 for a
// moment outside the 30 day window; neither changes on a retry
function refuse(hostname: string, path: string, status: number): Error {
	if (status === 401 || status === 403) {
		return new PermanentError('owner_token_rejected', 'the site refused the owner token');
	}
	if (status === 501) {
		return new PermanentError(
			'pitr_unsupported',
			'the site storage keeps no change log, so it cannot go back to a moment'
		);
	}
	if (status === 400) {
		return new PermanentError('pitr_refused', 'the site refused that moment or recovery point');
	}
	return new SiteAnswered(hostname, path, status);
}

export function pitrWorkerOf(fetcher: typeof fetch, timeoutMs: number): PitrWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	return {
		async bookmarkAt(hostname, at, auth) {
			const path = `/pitr?at=${encodeURIComponent(String(at))}`;
			const { status, text } = await fetchSite(
				hostname,
				path,
				{ method: 'GET', headers: bearer(auth) },
				(code) => code === 200
			);
			if (status !== 200) throw refuse(hostname, '/pitr', status);
			const parsed = atAnswer.safeParse(safeJson(text));
			if (!parsed.success) {
				throw new PermanentError('pitr_unreadable', 'the site gave no recovery point');
			}
			return parsed.data.bookmark;
		},

		async schedule(hostname, bookmark, auth) {
			const path = `/pitr?bookmark=${encodeURIComponent(bookmark)}`;
			const { status, text } = await fetchSite(
				hostname,
				path,
				{ method: 'POST', headers: bearer(auth) },
				(code) => code === 200
			);
			if (status !== 200) throw refuse(hostname, '/pitr', status);
			const parsed = scheduledAnswer.safeParse(safeJson(text));
			// no undo means nothing was scheduled, since the same call that schedules returns it
			if (!parsed.success) {
				throw new PermanentError(
					'pitr_no_undo',
					'the site scheduled no restore and gave no undo point'
				);
			}
			return { scheduled: parsed.data.scheduled, undo: parsed.data.undo };
		}
	};
}
