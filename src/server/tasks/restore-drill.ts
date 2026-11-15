import { defineTask } from 'nitropack/runtime';
import { ApiError } from '../../shared/errors';
import { runRestoreDrills } from '../services/restored-copies';

export default defineTask({
	meta: {
		name: 'restore-drill',
		description: 'Test restores the newest backup of a site that has not had one this week'
	},
	async run(): Promise<{ result?: unknown }> {
		try {
			return { result: await runRestoreDrills(Date.now()) };
		} catch (error) {
			if (error instanceof ApiError && error.code === 'not_built') {
				return {
					result: { skipped: 'the services are not installed in this isolate yet' }
				};
			}
			throw error;
		}
	}
});
