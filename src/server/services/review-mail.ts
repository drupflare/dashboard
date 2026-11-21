import type { CollegeDBClient } from '@earth-app/collegedb';
import type { NotificationCategory } from '../../shared/notifications';
import { getUserById } from '../db/repos/identity';
import type { MailStatus } from '../db/repos/mail-log';
import { listPreferences } from '../db/repos/notification-preferences';
import { listMembers } from '../db/repos/organization';
import type { MailInput } from '../emails';
import type { ReviewMailInput } from './governance';
import { shouldSend, type NotificationPrefs } from './notifications';

export interface Reviewer {
	email: string;
	userId: string;
	prefs: NotificationPrefs;
}

export interface ReviewMailDeps {
	recipients(orgId: string): Promise<Reviewer[]>;
	paused(): boolean | Promise<boolean>;
	record?(category: NotificationCategory, status: MailStatus): Promise<void>;
	unsubscribeUrl(reviewer: Reviewer, category: NotificationCategory): Promise<string>;
	send(to: string, input: MailInput): Promise<void>;
	baseUrl: string;
}

// owners and admins hold review.manage; each one's stored choices decide whether they get the mail
export async function collegeReviewers(db: CollegeDBClient, orgId: string): Promise<Reviewer[]> {
	const out: Reviewer[] = [];
	let after: string | undefined;
	for (;;) {
		const page = await listMembers(db, orgId, { after, limit: 100 });
		for (const member of page.items) {
			if (member.role !== 'owner' && member.role !== 'admin') continue;
			const user = await getUserById(db, member.userId);
			if (user !== null) {
				out.push({
					email: user.email,
					userId: user.id,
					prefs: await listPreferences(db, user.id)
				});
			}
		}
		if (page.nextCursor === null) break;
		after = page.nextCursor;
	}
	return out;
}

// "ops" is an optional class, so only a reviewer who opted in is mailed; the rest are counted
export function reviewMailer(deps: ReviewMailDeps) {
	return async (orgId: string, input: ReviewMailInput) => {
		let sent = 0;
		let skipped = 0;
		const paused = await deps.paused();
		for (const reviewer of await deps.recipients(orgId)) {
			if (!shouldSend('ops', reviewer.prefs, paused)) {
				skipped += 1;
				await deps.record?.('ops', paused ? 'skipped-paused' : 'skipped-preference');
				continue;
			}
			try {
				await deps.send(reviewer.email, {
					kind: 'access-review',
					orgName: input.orgName,
					scopeName: input.scopeName,
					dueDate: input.dueAt.slice(0, 10),
					reviewUrl: `${deps.baseUrl}${input.reviewUrl}`,
					unsubscribeUrl: await deps.unsubscribeUrl(reviewer, 'ops')
				});
				sent += 1;
				await deps.record?.('ops', 'sent').catch(() => undefined);
			} catch {
				skipped += 1;
				await deps.record?.('ops', 'failed').catch(() => undefined);
			}
		}
		return { sent, skipped };
	};
}
