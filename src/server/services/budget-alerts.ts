import type { CollegeDBClient } from '@earth-app/collegedb';
import type { AlertKey, SentAlert } from '../../shared/budget-rules';
import type { ContactRole } from '../../shared/contacts';
import type { NotificationCategory } from '../../shared/notifications';
import {
	listAlertsSent,
	orgScopeKey,
	recordAlertSent,
	releaseAlert,
	siteScopeKey
} from '../db/repos/budgets';
import { getContact } from '../db/repos/contacts';
import { getUserById } from '../db/repos/identity';
import type { MailStatus } from '../db/repos/mail-log';
import { listPreferences } from '../db/repos/notification-preferences';
import { getOrganization, listMembers } from '../db/repos/organization';
import { getSite } from '../db/repos/sites';
import { budgetAlertCategory, type MailInput } from '../emails';
import type { AlertNotice, AlertSink } from './budget-enforcement';
import { budgetOrder, isEssential, shouldSend, type NotificationPrefs } from './notifications';

// unreviewed: a volume cap for every platform send per UTC day, not a price
export const DAILY_MAIL_CAP = 100;

export interface AlertRecipient {
	email: string;
	// null for a contact that is not a user
	userId: string | null;
	// set for a contact, whose own notify switch is its preference
	contact?: { orgId: string; role: ContactRole };
	prefs: NotificationPrefs;
}

export interface BudgetAlertDeps {
	now(): number;
	log(message: string, detail: Record<string, unknown>): void;
	// the platform switch; it stops optional mail only
	paused(): boolean | Promise<boolean>;
	// the send log for a mail that was not delivered; a sent one goes through recordSent
	record?(category: NotificationCategory, status: MailStatus): Promise<void>;
	// what the daily send budget still allows; essential mail goes first
	remaining(): Promise<number>;
	// called once per delivered mail, so the send log counts what was sent
	recordSent(category: NotificationCategory): Promise<void>;
	sent(orgId: string, period: string): Promise<{ scopeKey: string; alertKey: string }[]>;
	// true when this call took the claim
	claim(orgId: string, scopeKey: string, period: string, alertKey: AlertKey): Promise<boolean>;
	release(orgId: string, scopeKey: string, period: string, alertKey: AlertKey): Promise<void>;
	recipients(orgId: string): Promise<AlertRecipient[]>;
	names(
		orgId: string,
		siteId: string | null
	): Promise<{ orgName: string; siteName: string | null }>;
	// absent until an unsubscribe signing secret exists; optional alerts wait for it
	unsubscribeUrl?(recipient: AlertRecipient, category: NotificationCategory): Promise<string>;
	budgetUrl(orgId: string): string;
	send(to: string, input: MailInput): Promise<void>;
}

const scopeKeyOf = (siteId: string | null) =>
	siteId === null ? orgScopeKey : siteScopeKey(siteId);

interface Item {
	category: NotificationCategory;
	key: AlertKey;
	to: string;
	input: MailInput;
}

export function budgetAlertSink(deps: BudgetAlertDeps): AlertSink {
	return {
		async sent(orgId, siteId, period) {
			const scopeKey = scopeKeyOf(siteId);
			return (await deps.sent(orgId, period))
				.filter((row) => row.scopeKey === scopeKey)
				.map((row): SentAlert => ({ key: row.alertKey as AlertKey, period }));
		},
		async notify(notice: AlertNotice) {
			const soft = notice.budget.enforcement === 'alert';
			const keys = notice.alerts.filter((key) => {
				if (key !== 'blocked') return true;
				// a soft budget never blocks, and shadow mode only logs what would have been blocked
				if (notice.mode === 'shadow' && !soft) {
					deps.log('budget block notice held back in shadow mode', {
						orgId: notice.orgId,
						siteId: notice.siteId
					});
				}
				return notice.mode === 'on' && !soft;
			});
			// optional alerts need an unsubscribe link, so they wait unclaimed until a secret exists
			const sendable = keys.filter((key) => {
				if (deps.unsubscribeUrl !== undefined || isEssential(budgetAlertCategory(key))) {
					return true;
				}
				deps.log('held: no unsubscribe secret', {
					orgId: notice.orgId,
					siteId: notice.siteId,
					key
				});
				return false;
			});
			if (sendable.length === 0) return;

			const [recipients, names] = await Promise.all([
				deps.recipients(notice.orgId),
				deps.names(notice.orgId, notice.siteId)
			]);
			const paused = await deps.paused();
			const items: Item[] = [];
			for (const key of sendable) {
				const category = budgetAlertCategory(key);
				for (const recipient of recipients) {
					if (!shouldSend(category, recipient.prefs, paused)) {
						await deps.record?.(
							category,
							paused ? 'skipped-paused' : 'skipped-preference'
						);
						continue;
					}
					const unsubscribeUrl = isEssential(category)
						? undefined
						: await deps.unsubscribeUrl?.(recipient, category);
					const input: MailInput = {
						kind: 'budget-alert',
						alert: key,
						orgName: names.orgName,
						siteName: names.siteName,
						views: notice.views,
						allowanceViews: notice.allowanceViews,
						budgetPercent: notice.budget.percent,
						soft,
						budgetUrl: deps.budgetUrl(notice.orgId),
						...(unsubscribeUrl === undefined ? {} : { unsubscribeUrl })
					};
					items.push({ category, key, to: recipient.email, input });
				}
			}

			const scopeKey = scopeKeyOf(notice.siteId);
			const { send, deferred } = budgetOrder(items, await deps.remaining());
			// an alert with any mail deferred waits for the next evaluation, unclaimed
			const waiting = new Set(deferred.map((item) => item.key));
			for (const key of sendable) {
				if (waiting.has(key)) continue;
				if (!(await deps.claim(notice.orgId, scopeKey, notice.period, key))) continue;
				const mine = send.filter((item) => item.key === key);
				// nobody to tell is still handled: the claim stays, so it is not tried every minute
				if (mine.length === 0) continue;
				let delivered = 0;
				for (const item of mine) {
					try {
						await deps.send(item.to, item.input);
					} catch (error) {
						deps.log('budget alert mail failed', {
							orgId: notice.orgId,
							key,
							message: error instanceof Error ? error.message : String(error)
						});
						await deps.record?.(item.category, 'failed').catch(() => undefined);
						continue;
					}
					delivered += 1;
					await deps.recordSent(item.category).catch((error: unknown) =>
						deps.log('mail log write failed', {
							orgId: notice.orgId,
							message: error instanceof Error ? error.message : String(error)
						})
					);
				}
				if (delivered === 0) await deps.release(notice.orgId, scopeKey, notice.period, key);
			}
		}
	};
}

// owners and billing members, plus the billing contact once its address is verified. A member's
// switches decide their mail; a contact's notify switch is its own
export async function collegeRecipients(
	db: CollegeDBClient,
	orgId: string
): Promise<AlertRecipient[]> {
	const out = new Map<string, AlertRecipient>();
	const add = (recipient: AlertRecipient) => {
		const key = recipient.email.trim().toLowerCase();
		const existing = out.get(key);
		out.set(key, {
			...recipient,
			prefs: { ...existing?.prefs, ...recipient.prefs },
			userId: existing?.userId ?? recipient.userId,
			contact: existing?.contact ?? recipient.contact
		});
	};
	let after: string | undefined;
	for (;;) {
		const page = await listMembers(db, orgId, { after, limit: 100 });
		for (const member of page.items) {
			if (member.role !== 'owner' && member.role !== 'billing') continue;
			const user = await getUserById(db, member.userId);
			if (user !== null) {
				add({
					email: user.email,
					userId: user.id,
					prefs: await listPreferences(db, user.id)
				});
			}
		}
		if (page.nextCursor === null) break;
		after = page.nextCursor;
	}
	const contact = await getContact(db, orgId, 'billing');
	if (contact !== null && contact.verifiedAt !== null) {
		add({
			email: contact.email,
			userId: null,
			contact: { orgId, role: 'billing' },
			prefs: contact.notifyOn ? { 'billing-info': true } : {}
		});
	}
	return [...out.values()];
}

export async function collegeNames(
	db: CollegeDBClient,
	orgId: string,
	siteId: string | null
): Promise<{ orgName: string; siteName: string | null }> {
	const org = await getOrganization(db, orgId);
	const site = siteId === null ? null : await getSite(db, orgId, siteId);
	return { orgName: org?.name ?? 'your organisation', siteName: site?.name ?? null };
}

export function collegeAlertStore(getDb: () => Promise<CollegeDBClient>) {
	return {
		async sent(orgId: string, period: string) {
			return (await listAlertsSent(await getDb(), orgId, period)).map((row) => ({
				scopeKey: row.scopeKey,
				alertKey: row.alertKey
			}));
		},
		async claim(orgId: string, scopeKey: string, period: string, alertKey: AlertKey) {
			return recordAlertSent(await getDb(), {
				organizationId: orgId,
				scopeKey,
				period,
				alertKey,
				sentAt: Date.now()
			});
		},
		async release(orgId: string, scopeKey: string, period: string, alertKey: AlertKey) {
			await releaseAlert(await getDb(), {
				organizationId: orgId,
				scopeKey,
				period,
				alertKey
			});
		}
	};
}
