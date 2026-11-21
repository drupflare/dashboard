import { defineTask } from 'nitropack/runtime';
import { ApiError } from '../../shared/errors';
import { runScheduledReviews } from '../services/access-reviews';
import { governanceServices } from '../services/governance';
import { notInstalled } from '../utils/task-skip';

export default defineTask({
	meta: {
		name: 'access-review-schedule',
		description: 'Opens a review for each organization whose review interval has run out'
	},
	async run(): Promise<{ result?: unknown }> {
		let deps;
		try {
			deps = governanceServices();
		} catch (error) {
			if (error instanceof ApiError && error.code === 'not_built') {
				return notInstalled('access-review-schedule');
			}
			throw error;
		}
		return { result: await runScheduledReviews(deps) };
	}
});
