import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../../src/server/domain/authorize';
import {
	ladderRowView,
	setSwitch,
	type LadderServices
} from '../../../../src/server/services/ladder';
import { ApiError } from '../../../../src/shared/errors';
import { CATALOGUE_ROWS } from '../../../../src/shared/health/catalogue';
import { GLOBAL_CONFIRMATION } from '../../../../src/shared/health/repair-copy';

const principal = { kind: 'user', userId: 'usr_1' } as unknown as Principal;

// no organisation or site row exists, so every scope id is unknown
function servicesWithEmptyStore(): LadderServices {
	const db = {
		first: async () => null,
		allAllShards: async () => [{ success: true, results: [] }],
		run: async () => ({})
	} as unknown as CollegeDBClient;
	return {
		getDb: async () => db,
		audit: async () => undefined,
		now: () => 1
	};
}

const refusal = async (promise: Promise<unknown>): Promise<ApiError> => {
	try {
		await promise;
	} catch (error) {
		return error as ApiError;
	}
	throw new Error('expected a refusal');
};

describe('what an admin sees per catalogue row', () => {
	it('marks an unrouted automatic row as not runnable, with the reason', () => {
		const row = CATALOGUE_ROWS.find((r) => r.repairId === 'bridge.asyncify_called');
		if (!row) throw new Error('row missing');
		const view = ladderRowView(row);
		expect(view.canRunToday).toBe(false);
		expect(view.reason).toBe(
			'No route on the site worker for this repair yet. It refuses to run.'
		);
	});

	it('marks a routed automatic row as runnable', () => {
		const row = CATALOGUE_ROWS.find((r) => r.repairId === 'render.empty');
		if (!row) throw new Error('row missing');
		expect(ladderRowView(row)).toMatchObject({ canRunToday: true, reason: null });
	});

	it('says a person must act on an approval row', () => {
		const row = CATALOGUE_ROWS.find((r) => r.automation === 'approval');
		if (!row) throw new Error('row missing');
		expect(ladderRowView(row).reason).toBe(
			'A person must approve this repair. Automatic repair does not run it.'
		);
	});
});

describe('changing a switch', () => {
	it('refuses the global switch without the typed confirmation', async () => {
		const error = await refusal(
			setSwitch(servicesWithEmptyStore(), {
				scope: 'global',
				scopeId: '',
				auto: false,
				confirmation: 'yes',
				principal
			})
		);
		expect(error.code).toBe('unprocessable');
		expect(error.message).toBe(`Type ${GLOBAL_CONFIRMATION} to change the global switch`);
	});

	it('accepts the global switch with the typed confirmation and writes no audit row', async () => {
		let audited = false;
		const services = { ...servicesWithEmptyStore(), audit: async () => (audited = true) };
		const view = await setSwitch(services, {
			scope: 'global',
			scopeId: '',
			auto: false,
			confirmation: GLOBAL_CONFIRMATION,
			principal
		});
		expect(view).toMatchObject({ scope: 'global', auto: false });
		expect(audited).toBe(false);
	});

	it('refuses a global switch that carries a scope id', async () => {
		const error = await refusal(
			setSwitch(servicesWithEmptyStore(), {
				scope: 'global',
				scopeId: 'org_a',
				auto: true,
				confirmation: GLOBAL_CONFIRMATION,
				principal
			})
		);
		expect(error.message).toBe('The global switch takes no scope id');
	});

	it('refuses an organization id that matches no organization', async () => {
		const error = await refusal(
			setSwitch(servicesWithEmptyStore(), {
				scope: 'organization',
				scopeId: 'org_missing',
				auto: true,
				confirmation: undefined,
				principal
			})
		);
		expect(error.message).toBe('No organization has this id');
	});

	it('refuses a site id that matches no site', async () => {
		const error = await refusal(
			setSwitch(servicesWithEmptyStore(), {
				scope: 'site',
				scopeId: 'site_missing',
				auto: true,
				confirmation: undefined,
				principal
			})
		);
		expect(error.message).toBe('No site has this id');
	});

	it('refuses an organization or site switch with no scope id', async () => {
		const error = await refusal(
			setSwitch(servicesWithEmptyStore(), {
				scope: 'site',
				scopeId: '',
				auto: true,
				confirmation: undefined,
				principal
			})
		);
		expect(error.message).toBe('This switch needs a scope id');
	});
});
