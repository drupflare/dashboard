import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { blobRequestBytes, MODIFY_MAX_REQUEST_BYTES } from '../../../src/shared/modify';
import type { EditLedger, EditRow, ModifyAnswer, ModifyFile, ModifyWorker } from '../ports';
import { PermanentError } from '../step';
import { SiteAnswered, siteFetcher } from './site';

const planAnswer = z.looseObject({ want: z.array(z.string()).default([]) });
const revisionsAnswer = z.looseObject({ active: z.string().nullable().default(null) });
const commitAnswer = z.looseObject({ ok: z.boolean().default(false), rev: z.string().optional() });

function json(text: string | null): unknown {
	try {
		return JSON.parse(text ?? '');
	} catch {
		return null;
	}
}

// the site's own words, bounded and without control characters, since they land in a record
function reasonOf(body: unknown, fallback: string): string {
	const error = (body as { error?: unknown } | null)?.error;
	const text =
		typeof error === 'string'
			? error
					.replace(/[\u0000-\u001f\u007f]/g, ' ')
					.trim()
					.slice(0, 300)
			: '';
	return text === '' ? fallback : text;
}

export function modifyWorkerOf(fetcher: typeof fetch, timeoutMs: number): ModifyWorker {
	const fetchSite = siteFetcher(fetcher, timeoutMs);
	const call = async (
		hostname: string,
		name: string,
		query: Record<string, string>,
		body: unknown,
		auth: { bearer: string }
	) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const params = new URLSearchParams({ package: name, ...query });
		const { status, text } = await fetchSite(
			hostname,
			`/modify?${params}`,
			{
				method: payload === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${auth.bearer}`,
					...(payload === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(payload === undefined ? {} : { body: payload })
			},
			() => true
		);
		if (status === 401 || status === 403) {
			throw new PermanentError('owner_token_rejected', 'the site refused the owner token');
		}
		if (status === 404) {
			throw new PermanentError(
				'modify_unavailable',
				'The site does not have the route that takes edits. Update the site, then try again.'
			);
		}
		if (status >= 500) throw new SiteAnswered(hostname, '/modify', status);
		const answer = json(text);
		// the site drops its interpreter to free memory and asks for the call again
		if ((answer as { retry?: unknown } | null)?.retry === true) {
			throw new Error('the site asked for the call again');
		}
		return { status, body: answer };
	};
	const unreadable = (what: string) => new Error(`the site gave no readable ${what}`);

	return {
		async active(hostname, name, auth) {
			const { status, body } = await call(
				hostname,
				name,
				{ action: 'revisions', limit: '1' },
				undefined,
				auth
			);
			if (status !== 200) {
				throw new PermanentError(
					'modify_refused',
					reasonOf(body, `The site refused to list its revisions (${status}).`)
				);
			}
			const parsed = revisionsAnswer.safeParse(body);
			if (!parsed.success) throw unreadable('revision list');
			return parsed.data.active;
		},

		async deliver(hostname, delivery, auth): Promise<ModifyAnswer> {
			const { name, label, files } = delivery;
			const plan = await call(
				hostname,
				name,
				{ action: 'plan' },
				{ files: files.map(({ path, hash, bytes }) => ({ path, hash, bytes })) },
				auth
			);
			const planned = planAnswer.safeParse(plan.body);
			if (plan.status !== 200 || !planned.success) {
				return {
					kind: 'refused',
					reason: reasonOf(plan.body, 'The site refused the file list.')
				};
			}
			const wanted = new Set(planned.data.want);
			const missing = new Map<string, ModifyFile>();
			for (const file of files) if (wanted.has(file.hash)) missing.set(file.hash, file);
			// a request holds at most what the site's body ceiling allows, so a large set goes in several
			let batch: ModifyFile[] = [];
			let size = 0;
			const sendBatch = async () => {
				if (batch.length === 0) return null;
				const sent = await call(
					hostname,
					name,
					{ action: 'blobs' },
					{ blobs: batch.map(({ hash, source }) => ({ hash, source })) },
					auth
				);
				batch = [];
				size = 0;
				return sent.status === 200
					? null
					: reasonOf(sent.body, 'The site did not take every file.');
			};
			for (const file of missing.values()) {
				const bytes = blobRequestBytes(file.source);
				if (size + bytes > MODIFY_MAX_REQUEST_BYTES) {
					const refused = await sendBatch();
					if (refused !== null) return { kind: 'refused', reason: refused };
				}
				batch.push(file);
				size += bytes;
			}
			const refused = await sendBatch();
			if (refused !== null) return { kind: 'refused', reason: refused };
			const commit = await call(
				hostname,
				name,
				{ action: 'commit', label, origin: 'dashboard' },
				{ files: files.map(({ path, hash }) => ({ path, hash })) },
				auth
			);
			const committed = commitAnswer.safeParse(commit.body);
			if (commit.status === 200 && committed.success && committed.data.ok) {
				if (committed.data.rev === undefined) throw unreadable('answer to the commit');
				return { kind: 'applied', rev: committed.data.rev };
			}
			return {
				kind: 'refused',
				reason: reasonOf(commit.body, `The site refused the edit (${commit.status}).`)
			};
		},

		async activate(hostname, name, rev, auth) {
			const { status, body } = await call(
				hostname,
				name,
				{ action: 'activate', rev },
				{},
				auth
			);
			const parsed = commitAnswer.safeParse(body);
			return { ok: status === 200 && parsed.success && parsed.data.ok };
		}
	};
}

export class D1EditLedger implements EditLedger {
	constructor(private readonly db: D1Database) {}

	// the release is read from the site row in the same statement, and a repeat of the id adds nothing
	async record(row: EditRow): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO site_revisions (id, organization_id, site_id, kind, release_id, bundle_key,
				note, created_at)
				SELECT ?, s.organization_id, s.id, 'edit', s.release_id, ?, ?, ? FROM sites s
				WHERE s.id = ? AND s.organization_id = ?
				ON CONFLICT (id) DO NOTHING`
			)
			.bind(row.id, row.bundleKey, row.note, row.now, row.siteId, row.organizationId)
			.run();
	}
}
