import {
	unsubscribeQuerySchema,
	unsubscribeResultSchema
} from '../../../shared/notification-preferences';
import { preferenceServices, unsubscribe } from '../../services/notification-preferences';
import { defineApi } from '../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'notification.unsubscribe',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Stop one kind of optional mail',
		description:
			'Switches off the one category named in the signed link from an email. The link carries the token in its query; a mail client posts the one-click form to it and the body is ignored. Essential mail has no link. Using a link again changes nothing.',
		query: unsubscribeQuerySchema,
		response: unsubscribeResultSchema
	},
	async ({ query }) => unsubscribe(preferenceServices(), query.token)
);
