import { defineTask } from 'nitropack/runtime';
import { ApiError } from '../../shared/errors';
import { sweepExpiredEnvironments } from '../services/restored-copies';
import { notInstalled } from '../utils/task-skip';

export default defineTask({
	meta: {
		name: 'environment-ttl-sweep',
		description: 'Deletes the preview copies whose time has run out'
	},
	async run(): Promise<{ result?: unknown }> {
		try {
			return { result: await sweepExpiredEnvironments(Date.now()) };
		} catch (error) {
			if (error instanceof ApiError && error.code === 'not_built') {
				return notInstalled('environment-ttl-sweep');
			}
			throw error;
		}
	}
});
