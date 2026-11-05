import { defineApi } from '../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.explode' as never,
		rateClass: 'read',
		tags: ['sites'],
		summary: 'An action nobody registered'
	},
	() => ({})
);
