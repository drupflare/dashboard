import { z } from 'zod';
import type { InstallVerdict, ModuleWorker, OwnerAuth } from '../ports';
import { PermanentError } from '../step';
import { SiteAnswered, siteFetcher } from './site';

const bearer = (auth: OwnerAuth) => ({ authorization: `Bearer ${auth.bearer}` });

const verdictAnswer = z.looseObject({
	verdict: z.enum(['installable', 'blocked', 'unverifiable', 'not-found']),
	conflicts: z
		.array(
			z.looseObject({
				requires: z.string(),
				constraint: z.string(),
				installed: z.string().nullable().default(null),
				reason: z.string()
			})
		)
		.default([])
});

const enableAnswer = z.looseObject({
	ok: z.boolean().default(false),
	retry: z.boolean().optional(),
	armFill: z.boolean().optional(),
	alreadyEnabled: z.boolean().optional(),
	nowEnabled: z.boolean().optional(),
	discoverable: z.boolean().optional(),
	kind: z.string().optional()
});

const installAnswer = z.looseObject({ ok: z.boolean().default(false) });

function json(text: string | null): unknown {
	try {
		return JSON.parse(text ?? '');
	} catch {
		return null;
	}
}

function refusedToken(status: number): void {
	if (status === 401 || status === 403) {
		throw new PermanentError('owner_token_rejected', 'the site refused the owner token');
	}
}

export function moduleWorkerOf(fetcher: typeof fetch, timeoutMs: number): ModuleWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	const call = async (
		hostname: string,
		path: string,
		method: 'GET' | 'POST',
		auth: OwnerAuth
	) => {
		const { status, text } = await fetchSite(
			hostname,
			path,
			{ method, headers: bearer(auth) },
			() => true
		);
		refusedToken(status);
		return { status, body: json(text) };
	};
	const unreadable = (what: string) => new Error(`the site gave no readable ${what}`);

	return {
		async installable(hostname, name, auth): Promise<InstallVerdict> {
			const path = `/installable?module=${encodeURIComponent(name)}`;
			const { status, body } = await call(hostname, path, 'GET', auth);
			if (status >= 500) throw new SiteAnswered(hostname, '/installable', status);
			const parsed = verdictAnswer.safeParse(body);
			if (!parsed.success) throw unreadable('answer to the module check');
			return parsed.data;
		},

		// a dry enable reports whether Drupal can see the module and whether it is on already
		async read(hostname, project, auth) {
			const path = `/enable?module=${encodeURIComponent(project)}&dry=1`;
			const { status, body } = await call(hostname, path, 'POST', auth);
			if (status >= 500) throw new SiteAnswered(hostname, '/enable', status);
			const parsed = enableAnswer.safeParse(body);
			if (!parsed.success) throw unreadable('module reading');
			// the site drops its interpreter to free memory and asks for the call again
			if (parsed.data.retry === true) throw new Error('the site asked for the call again');
			const { discoverable, kind, alreadyEnabled } = parsed.data;
			return {
				present: discoverable === true || kind === 'theme',
				enabled: alreadyEnabled === true
			};
		},

		// deps=1 brings the packages the module requires; a conflict is refused by the site
		async install(hostname, name, auth) {
			const path = `/install?module=${encodeURIComponent(name)}&deps=1`;
			const { status, body } = await call(hostname, path, 'POST', auth);
			if (status >= 500 && status !== 502)
				throw new SiteAnswered(hostname, '/install', status);
			const parsed = installAnswer.safeParse(body);
			return { ok: status === 200 && parsed.success && parsed.data.ok };
		},

		async enable(hostname, project, auth) {
			const path = `/enable?module=${encodeURIComponent(project)}`;
			const { status, body } = await call(hostname, path, 'POST', auth);
			if (status >= 500) throw new SiteAnswered(hostname, '/enable', status);
			const parsed = enableAnswer.safeParse(body);
			if (!parsed.success) throw unreadable('answer to the enable');
			if (parsed.data.retry === true) throw new Error('the site asked for the call again');
			// the enable queues work that a second event starts
			if (parsed.data.armFill === true) {
				await call(hostname, '/armfill', 'POST', auth).catch(() => undefined);
			}
			return { ok: parsed.data.ok && parsed.data.nowEnabled !== false };
		},

		// the site has no uninstall route and no theme route yet, so both answer not_available
		async uninstall() {
			return { kind: 'not_available' };
		},

		async setDefaultTheme() {
			return { kind: 'not_available' };
		}
	};
}
