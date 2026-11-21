// Essential mail ignores preferences. Optional mail follows each user's switches, which start on
// for the categories that send. There is deliberately no category for promotions, announcements or
// referrals.
export const ESSENTIAL_CATEGORIES = [
	'login-code',
	'invitation',
	'security-event',
	'payment-failure',
	'mandatory-notice',
	'budget-limit'
] as const;

export const OPTIONAL_CATEGORIES = ['ops', 'billing-info', 'reports', 'digest'] as const;

// on until the user turns them off; the daily summary has no sender yet, so it starts off
export const DEFAULT_ON_CATEGORIES = ['ops', 'billing-info', 'reports'] as const;

export const NOTIFICATION_CATEGORIES = [...ESSENTIAL_CATEGORIES, ...OPTIONAL_CATEGORIES] as const;

export type EssentialCategory = (typeof ESSENTIAL_CATEGORIES)[number];
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
