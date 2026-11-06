// Essential mail ignores preferences. Optional mail needs an opt-in. There is deliberately no
// category for promotions, announcements or referrals.
export const ESSENTIAL_CATEGORIES = [
	'login-code',
	'invitation',
	'security-event',
	'payment-failure',
	'mandatory-notice'
] as const;

export const OPTIONAL_CATEGORIES = ['ops', 'billing-info', 'reports', 'digest'] as const;

export const NOTIFICATION_CATEGORIES = [...ESSENTIAL_CATEGORIES, ...OPTIONAL_CATEGORIES] as const;

export type EssentialCategory = (typeof ESSENTIAL_CATEGORIES)[number];
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
