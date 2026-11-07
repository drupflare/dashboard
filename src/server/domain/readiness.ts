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

export const CHECK_LABELS = {
	responds: 'the site responds',
	admin: 'admin access verified',
	domain: 'a custom domain verified',
	https: 'HTTPS verified',
	backup: 'a backup restored in a test',
	alert: 'a critical alert configured with a delivered test notification',
	technical: 'a named technical contact',
	billing: 'a named billing contact',
	recovery: 'a named recovery contact'
} as const;

const LIVE: Check[] = [[CHECK_LABELS.responds, (o) => o.siteResponds]];

const VERIFIED: Check[] = [
	[CHECK_LABELS.admin, (o) => o.adminAccessVerified],
	[CHECK_LABELS.domain, (o) => !o.intendedUseNeedsDomain || o.customDomainVerified],
	[CHECK_LABELS.https, (o) => !o.intendedUseNeedsDomain || o.httpsVerified]
];

const PRODUCTION: Check[] = [
	[CHECK_LABELS.backup, (o) => o.backupRestoredInTest],
	[CHECK_LABELS.alert, (o) => o.criticalAlertConfigured && o.testNotificationDelivered],
	[CHECK_LABELS.technical, (o) => o.contacts.technical],
	[CHECK_LABELS.billing, (o) => o.contacts.billing],
	[CHECK_LABELS.recovery, (o) => o.contacts.recovery]
];

const TIERS: [Exclude<ReadinessLevel, 'pending'>, Check[]][] = [
	['live', LIVE],
	['verified', VERIFIED],
	['production-ready', PRODUCTION]
];

// derived on every call, never stored; a lapsed observation drops the level
export function readiness(o: ReadinessObservations): Readiness {
	let level: ReadinessLevel = 'pending';
	for (const [next, checks] of TIERS) {
		const unmet = checks.filter(([, holds]) => !holds(o)).map(([label]) => label);
		if (unmet.length > 0) return { level, missing: unmet };
		level = next;
	}
	return { level, missing: [] };
}

export type ReadinessCheck = {
	label: string;
	tier: Exclude<ReadinessLevel, 'pending'>;
	holds: boolean;
};

// every check with the tier it belongs to, so a screen can list the ones already met
export function readinessChecks(o: ReadinessObservations): ReadinessCheck[] {
	return TIERS.flatMap(([tier, checks]) =>
		checks.map(([label, holds]) => ({ label, tier, holds: holds(o) }))
	);
}
