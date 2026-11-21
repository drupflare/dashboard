import { defineTask } from 'nitropack/runtime';
import { ApiError } from '../../shared/errors';
import { evaluateAllBudgets } from '../services/budget-enforcement';
import { budgetServices } from '../services/budgets';
import { notInstalled } from '../utils/task-skip';

export default defineTask({
	meta: {
		name: 'budget-evaluate',
		description:
			'Compares each organisation and site with its spend budget and applies the block'
	},
	async run(): Promise<{ result?: unknown }> {
		let deps;
		try {
			deps = budgetServices().enforcement();
		} catch (error) {
			if (error instanceof ApiError && error.code === 'not_built') {
				return notInstalled('budget-evaluate');
			}
			throw error;
		}
		if (deps === null) {
			return { result: { skipped: 'the engine binding or the counts secret is missing' } };
		}
		const outcomes = await evaluateAllBudgets(deps);
		return {
			result: {
				mode: deps.mode,
				organisations: outcomes.length,
				changed: outcomes.flatMap((o) => o.sites).filter((s) => s.action !== 'unchanged')
					.length
			}
		};
	}
});
