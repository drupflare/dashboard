import {
	preferencesBodySchema,
	preferencesResponse
} from '../../../../shared/notification-preferences';
import { preferenceServices, setPreferences } from '../../../services/notification-preferences';
import type { UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.write',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Change mail preferences',
		description:
			'Switches optional mail on or off for the signed-in account. It works from a browser session only, never with an API key. Essential mail cannot be switched off, and naming it is refused.',
		body: preferencesBodySchema,
		response: preferencesResponse
	},
	async ({ principal, body }) => {
		const { userId } = principal as UserPrincipal;
		return setPreferences(preferenceServices(), userId, body.preferences);
	}
);
