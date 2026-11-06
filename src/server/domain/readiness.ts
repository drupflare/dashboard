export type ReadinessObservations = {
	siteResponds: boolean;
	adminAccessVerified: boolean;
	backupRestoredInTest: boolean;
	intendedUseNeedsDomain: boolean;
	customDomainVerified: boolean;
	httpsVerified: boolean;
	criticalAlertConfigured: boolean;
	testNotificationDelivered: boolean;
	contacts: { technical: boolean; billing: boolean; recovery: boolean };
};

export type ReadinessLevel = 'pending' | 'live' | 'verified' | 'production-ready';

export type Readiness = { level: ReadinessLevel; missing: string[] };

type Check = [label: string, holds: (o: ReadinessObservations) => boolean];

const LIVE: Check[] = [['the site responds', (o) => o.siteResponds]];

const VERIFIED: Check[] = [
	['admin access verified', (o) => o.adminAccessVerified],
	['a custom domain verified', (o) => !o.intendedUseNeedsDomain || o.customDomainVerified],
	['HTTPS verified', (o) => !o.intendedUseNeedsDomain || o.httpsVerified]
];

const PRODUCTION: Check[] = [
	['a backup restored in a test', (o) => o.backupRestoredInTest],
	[
		'a critical alert configured with a delivered test notification',
		(o) => o.criticalAlertConfigured && o.testNotificationDelivered
	],
	['a named technical contact', (o) => o.contacts.technical],
	['a named billing contact', (o) => o.contacts.billing],
	['a named recovery contact', (o) => o.contacts.recovery]
];

// derived on every call, never stored; a lapsed observation drops the level
export function readiness(o: ReadinessObservations): Readiness {
	const tiers: [ReadinessLevel, Check[]][] = [
		['live', LIVE],
		['verified', VERIFIED],
		['production-ready', PRODUCTION]
	];
	let level: ReadinessLevel = 'pending';
	for (const [next, checks] of tiers) {
		const unmet = checks.filter(([, holds]) => !holds(o)).map(([label]) => label);
		if (unmet.length > 0) return { level, missing: unmet };
		level = next;
	}
	return { level, missing: [] };
}
