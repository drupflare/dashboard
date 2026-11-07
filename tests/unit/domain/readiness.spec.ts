import { describe, expect, it } from 'vitest';
import {
	CHECK_LABELS,
	readiness,
	readinessChecks,
	type ReadinessObservations
} from '../../../src/server/domain/readiness';

const full: ReadinessObservations = {
	siteResponds: true,
	adminAccessVerified: true,
	backupRestoredInTest: true,
	intendedUseNeedsDomain: true,
	customDomainVerified: true,
	httpsVerified: true,
	criticalAlertConfigured: true,
	testNotificationDelivered: true,
	contacts: { technical: true, billing: true, recovery: true }
};

const subdomain: ReadinessObservations = {
	...full,
	intendedUseNeedsDomain: false,
	customDomainVerified: false,
	httpsVerified: false
};

describe('readiness levels', () => {
	it('is pending until the site responds', () => {
		expect(readiness({ ...full, siteResponds: false }).level).toBe('pending');
	});

	it('is live when the site responds and nothing else is verified', () => {
		const obs = { ...subdomain, adminAccessVerified: false };
		expect(readiness(obs).level).toBe('live');
	});

	it('is production ready with every check', () => {
		expect(readiness(full)).toEqual({ level: 'production-ready', missing: [] });
	});

	it('lets a free subdomain site be verified without a custom domain', () => {
		const out = readiness({ ...subdomain, backupRestoredInTest: false });
		expect(out.level).toBe('verified');
		expect(out.missing).toContain('a backup restored in a test');
	});

	it('needs the custom domain and HTTPS when the intended use needs them', () => {
		expect(readiness({ ...full, customDomainVerified: false }).level).toBe('live');
		expect(readiness({ ...full, httpsVerified: false }).level).toBe('live');
	});
});

describe('readiness is derived from observations', () => {
	it('moves back down when one observation lapses', () => {
		expect(readiness(full).level).toBe('production-ready');
		expect(readiness({ ...full, siteResponds: false }).level).toBe('pending');
		expect(readiness({ ...full, testNotificationDelivered: false }).level).toBe('verified');
		expect(readiness({ ...full, contacts: { ...full.contacts, recovery: false } }).level).toBe(
			'verified'
		);
	});

	it('names the missing checks for the next level', () => {
		const out = readiness({
			...full,
			criticalAlertConfigured: false,
			contacts: { technical: true, billing: false, recovery: true }
		});
		expect(out.level).toBe('verified');
		expect(out.missing).toEqual([
			'a critical alert configured with a delivered test notification',
			'a named billing contact'
		]);
	});
});

describe('readiness checks', () => {
	it('lists every check once, in tier order, with whether it holds', () => {
		const out = readinessChecks({ ...full, adminAccessVerified: false });

		expect(out.map((check) => check.label)).toEqual(Object.values(CHECK_LABELS));
		expect(out.map((check) => check.tier)).toEqual([
			'live',
			'verified',
			'verified',
			'verified',
			'production-ready',
			'production-ready',
			'production-ready',
			'production-ready',
			'production-ready'
		]);
		expect(out.filter((check) => !check.holds).map((check) => check.label)).toEqual([
			CHECK_LABELS.admin
		]);
	});

	it('agrees with the level about what is missing', () => {
		const o = { ...full, contacts: { ...full.contacts, billing: false } };
		const unmet = readinessChecks(o).filter((check) => !check.holds);

		expect(unmet.map((check) => check.label)).toEqual(readiness(o).missing);
	});
});
