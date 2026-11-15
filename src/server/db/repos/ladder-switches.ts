import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	switchesOf,
	type LadderScope,
	type LadderSwitches,
	type SwitchRow
} from '../../../../engine/src/repair/rows';
import { DIRECTORY_KEY } from '../collegedb';

export type { LadderScope, LadderSwitches };

// the global level has no id of its own
export const GLOBAL_SCOPE_ID = '';

// switches are few and read on every tick, so they all live on the directory shard
export async function getLadderSwitches(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<LadderSwitches> {
	const { results } = await db.all<SwitchRow>(
		DIRECTORY_KEY,
		`SELECT scope, scope_id, auto FROM ladder_switches
		 WHERE scope = 'global' OR (scope = 'organization' AND scope_id = ?)
		 OR (scope = 'site' AND scope_id = ?)`,
		[organizationId, siteId]
	);
	return switchesOf(results, organizationId, siteId);
}

export async function setLadderSwitch(
	db: CollegeDBClient,
	input: {
		scope: LadderScope;
		scopeId: string;
		auto: boolean;
		updatedBy: string;
		now: number;
	}
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO ladder_switches (scope, scope_id, auto, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (scope, scope_id) DO UPDATE SET auto = excluded.auto,
		 updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
		[
			input.scope,
			input.scope === 'global' ? GLOBAL_SCOPE_ID : input.scopeId,
			input.auto ? 1 : 0,
			input.now,
			input.updatedBy
		]
	);
}

// a level with no row is unset, which the ladder reads as off at the global level
export async function clearLadderSwitch(
	db: CollegeDBClient,
	scope: LadderScope,
	scopeId: string
): Promise<void> {
	await db.run(DIRECTORY_KEY, 'DELETE FROM ladder_switches WHERE scope = ? AND scope_id = ?', [
		scope,
		scope === 'global' ? GLOBAL_SCOPE_ID : scopeId
	]);
}
