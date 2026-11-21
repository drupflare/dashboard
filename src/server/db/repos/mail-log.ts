import type { CollegeDBClient } from '@earth-app/collegedb';

export type MailStatus = 'sent' | 'failed' | 'skipped-paused' | 'skipped-preference';

// the log is one logical table, so every row shares one shard key, as the ledger does
export const MAIL_LOG_KEY = 'mail-log';

export async function recordMailSent(
	db: CollegeDBClient,
	row: { category: string; class: 'essential' | 'optional'; at: number }
): Promise<void> {
	await db.run(
		MAIL_LOG_KEY,
		`INSERT INTO mail_log (category, class, status, at) VALUES (?, ?, 'sent', ?)`,
		[row.category, row.class, row.at]
	);
}

export async function countMailSentSince(db: CollegeDBClient, since: number): Promise<number> {
	const { results } = await db.all<{ n: number }>(
		MAIL_LOG_KEY,
		`SELECT COUNT(*) AS n FROM mail_log WHERE status = 'sent' AND at >= ?`,
		[since]
	);
	return results[0]?.n ?? 0;
}

// no address and no body: a category, its class, what became of the mail and when
export async function recordMail(
	db: CollegeDBClient,
	row: { category: string; class: 'essential' | 'optional'; status: MailStatus; at: number }
): Promise<void> {
	await db.run(
		MAIL_LOG_KEY,
		'INSERT INTO mail_log (category, class, status, at) VALUES (?, ?, ?, ?)',
		[row.category, row.class, row.status, row.at]
	);
}

export async function mailCountsSince(
	db: CollegeDBClient,
	since: number
): Promise<Record<MailStatus, number>> {
	const { results } = await db.all<{ status: MailStatus; n: number }>(
		MAIL_LOG_KEY,
		'SELECT status, COUNT(*) AS n FROM mail_log WHERE at >= ? GROUP BY status',
		[since]
	);
	const out: Record<MailStatus, number> = {
		sent: 0,
		failed: 0,
		'skipped-paused': 0,
		'skipped-preference': 0
	};
	for (const row of results) out[row.status] = row.n;
	return out;
}
