import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	ORG_SETTING_DEFAULTS,
	ORG_SETTING_KEYS,
	type OrgSettings
} from '../../shared/org-settings';
import { getOrgSetting, putOrgSetting } from '../db/repos/org-settings';
import type { GovernanceActor, GovernanceServices } from './governance';
import { principalActor } from './owner-tokens';

export async function departmentAdminsDecideReviews(
	db: CollegeDBClient,
	orgId: string
): Promise<boolean> {
	const stored = await getOrgSetting(db, orgId, ORG_SETTING_KEYS.departmentAdminsDecideReviews);
	return stored === null ? ORG_SETTING_DEFAULTS.departmentAdminsDecideReviews : stored === '1';
}

export async function getOrgSettings(
	deps: GovernanceServices,
	orgId: string
): Promise<OrgSettings> {
	return {
		departmentAdminsDecideReviews: await departmentAdminsDecideReviews(
			await deps.getDb(),
			orgId
		)
	};
}

export async function setOrgSettings(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	body: OrgSettings
): Promise<OrgSettings> {
	const db = await deps.getDb();
	const by = principalActor(actor.principal);
	const before = await departmentAdminsDecideReviews(db, orgId);
	await putOrgSetting(db, orgId, {
		key: ORG_SETTING_KEYS.departmentAdminsDecideReviews,
		value: body.departmentAdminsDecideReviews ? '1' : '0',
		setBy: by,
		at: deps.now()
	});
	await deps.audit(orgId, {
		actor: by,
		action: 'org.settings.updated',
		target: orgId,
		detail: {
			setting: ORG_SETTING_KEYS.departmentAdminsDecideReviews,
			from: before,
			to: body.departmentAdminsDecideReviews
		}
	});
	return getOrgSettings(deps, orgId);
}
