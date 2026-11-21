import { ApiError } from '../../../../shared/errors';
import { preferencesResponse } from '../../../../shared/notification-preferences';
import { getPreferencesView, preferenceServices } from '../../../services/notification-preferences';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'Read mail preferences',
		description:
			'Lists the optional mail you can switch on or off, with each switch on until you turn it off, and the mail that always sends. Essential mail has no switch.',
		response: preferencesResponse
	},
	async ({ principal }) => {
		if (principal === null) throw new ApiError('unauthenticated', 'Authentication is required');
		const userId = principal.kind === 'user' ? principal.userId : principal.issuerId;
		return getPreferencesView(preferenceServices(), userId);
	}
);
