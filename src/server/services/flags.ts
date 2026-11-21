import type { CollegeDBClient } from '@earth-app/collegedb';
import { getGlobalLadderSwitch } from '../db/repos/ladder-switches';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import { PLATFORM_FLAG_KEYS, listPlatformFlags, setPlatformFlag } from '../db/repos/platform-flags';
import type { Principal } from '../domain/authorize';
import { ladderServices, setSwitch } from './ladder';
import { principalActor } from './owner-tokens';

export const FLAG_KEYS = [...PLATFORM_FLAG_KEYS, 'ladder.auto'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export interface FlagView {
	key: FlagKey;
	value: boolean;
	// null when no one has set the flag since it was created
	setBy: string | null;
	setAt: number | null;
}

// ladder.auto is the global repair switch, so it reads from ladder_switches rather than a copy
export async function listFlags(db: CollegeDBClient): Promise<FlagView[]> {
	const rows = new Map((await listPlatformFlags(db)).map((row) => [row.key, row]));
	const ladder = await getGlobalLadderSwitch(db);
	return FLAG_KEYS.map((key): FlagView => {
		if (key === 'ladder.auto') {
			return {
				key,
				value: ladder?.auto ?? false,
				setBy: ladder?.updatedBy ?? null,
				setAt: ladder?.updatedAt ?? null
			};
		}
		const row = rows.get(key);
		return {
			key,
			value: row?.value ?? false,
			setBy: row?.setBy ?? null,
			setAt: row?.setAt ?? null
		};
	});
}

// a switch change is audited before it takes effect, in the same way as the ladder's own writes
export async function setFlag(
	db: CollegeDBClient,
	input: {
		key: FlagKey;
		value: boolean;
		confirmation?: string;
		principal: Principal;
		now: number;
	}
): Promise<FlagView> {
	if (input.key === 'ladder.auto') {
		await setSwitch(ladderServices(), {
			scope: 'global',
			scopeId: '',
			auto: input.value,
			...(input.confirmation === undefined ? {} : { confirmation: input.confirmation }),
			principal: input.principal
		});
	} else {
		const actor = principalActor(input.principal);
		await appendPlatformAudit(db, {
			actor,
			action: 'admin.flags.set',
			target: input.key,
			detail: { value: input.value },
			now: input.now
		});
		await setPlatformFlag(db, {
			key: input.key,
			value: input.value,
			setBy: actor,
			now: input.now
		});
	}
	const view = (await listFlags(db)).find((flag) => flag.key === input.key);
	if (view === undefined) throw new Error('the flag is missing after it was set');
	return view;
}
