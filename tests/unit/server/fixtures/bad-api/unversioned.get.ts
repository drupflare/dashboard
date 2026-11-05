import { defineApi } from '../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'A route outside v1'
	},
	() => ({})
);
