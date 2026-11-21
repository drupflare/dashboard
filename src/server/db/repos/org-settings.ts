import type { CollegeDBClient } from '@earth-app/collegedb';

export async function getOrgSetting(
	db: CollegeDBClient,
	orgId: string,
	key: string
): Promise<string | null> {
	const row = await db.first<{ value: string }>(
		orgId,
		'SELECT value FROM org_settings WHERE organization_id = ? AND setting = ?',
		[orgId, key]
	);
	return row?.value ?? null;
}

export async function putOrgSetting(
	db: CollegeDBClient,
	orgId: string,
	input: { key: string; value: string; setBy: string; at: number }
): Promise<void> {
	await db.run(
		orgId,
		`INSERT INTO org_settings (organization_id, setting, value, set_by, set_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (organization_id, setting) DO UPDATE SET value = excluded.value,
		 set_by = excluded.set_by, set_at = excluded.set_at`,
		[orgId, input.key, input.value, input.setBy, input.at]
	);
}
