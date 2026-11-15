import { z } from 'zod';
import { settingsResponseSchema } from '../../../src/shared/site-config/levers';
import type { OwnerAuth, SettingsWorker } from '../ports';
import { PermanentError } from '../step';
import { SiteAnswered, siteFetcher } from './site';

const bearer = (auth: OwnerAuth) => ({ authorization: `Bearer ${auth.bearer}` });

const writeAnswer = z.looseObject({
	ok: z.literal(true),
	refused: z.array(z.string()).default([]),
	invalid: z.array(z.object({ name: z.string(), reason: z.string() })).default([])
});

function safeJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// a 501 means the site has no storage for an override; a 400 is a body the site will not take
function refuse(hostname: string, status: number): Error {
	if (status === 401 || status === 403) {
		return new PermanentError('owner_token_rejected', 'the site refused the owner token');
	}
	if (status === 412) {
		return new PermanentError('settings_changed', 'the settings changed since they were read');
	}
	if (status === 501) {
		return new PermanentError(
			'settings_unsupported',
			'the site has nowhere to store a settings override'
		);
	}
	if (status === 400) {
		return new PermanentError('settings_refused', 'the site refused the settings it was sent');
	}
	return new SiteAnswered(hostname, '/settings', status);
}

export function settingsWorkerOf(fetcher: typeof fetch, timeoutMs: number): SettingsWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	return {
		async read(hostname, auth) {
			const { status, text } = await fetchSite(
				hostname,
				'/settings',
				{ method: 'GET', headers: bearer(auth) },
				(code) => code === 200
			);
			if (status !== 200) throw refuse(hostname, status);
			const parsed = settingsResponseSchema.safeParse(safeJson(text));
			if (!parsed.success) {
				throw new PermanentError(
					'settings_unreadable',
					'the site gave settings in a shape we cannot read'
				);
			}
			return parsed.data.levers;
		},

		async write(hostname, patch, auth, ifMatch) {
			const { status, text } = await fetchSite(
				hostname,
				'/settings',
				{
					method: 'PUT',
					headers: {
						...bearer(auth),
						'content-type': 'application/json',
						...(ifMatch !== null ? { 'if-match': ifMatch } : {})
					},
					body: JSON.stringify(patch)
				},
				(code) => code === 200
			);
			if (status !== 200) throw refuse(hostname, status);
			const parsed = writeAnswer.safeParse(safeJson(text));
			if (!parsed.success) {
				throw new PermanentError(
					'settings_unreadable',
					'the site did not say what it stored'
				);
			}
			return { refused: parsed.data.refused, invalid: parsed.data.invalid };
		}
	};
}
