import { z } from 'zod';
import { ESSENTIAL_CATEGORIES, OPTIONAL_CATEGORIES } from '../../../../shared/notifications';
import { nowUtc } from '../../../../shared/utils/time';
import { mailCountsSince } from '../../../db/repos/mail-log';
import { isPlatformFlagOn } from '../../../db/repos/platform-flags';
import { DAILY_MAIL_CAP } from '../../../services/budget-alerts';
import { organizationServices } from '../../../services/organizations';
import { defineApi } from '../../../utils/define-api';

const DAY = 86_400_000;

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the mail categories and the notification switch',
		description:
			'The mail categories, essential or optional, and whether optional mail is paused. The send log for the current UTC day: mail sent, failed and skipped, by count only, with the daily send cap. The log holds no address and no body.',
		response: z.object({
			essential: z.array(z.string()),
			optional: z.array(z.string()),
			notificationsPaused: z.boolean(),
			today: z.object({
				sent: z.number(),
				failed: z.number(),
				skippedPaused: z.number(),
				skippedPreference: z.number()
			}),
			dailyCap: z.number()
		})
	},
	async () => {
		const db = await organizationServices().getDb();
		const counts = await mailCountsSince(db, Math.floor(nowUtc().toMillis() / DAY) * DAY);
		return {
			essential: [...ESSENTIAL_CATEGORIES],
			optional: [...OPTIONAL_CATEGORIES],
			notificationsPaused: await isPlatformFlagOn(db, 'notifications.paused'),
			today: {
				sent: counts.sent,
				failed: counts.failed,
				skippedPaused: counts['skipped-paused'],
				skippedPreference: counts['skipped-preference']
			},
			dailyCap: DAILY_MAIL_CAP
		};
	}
);
