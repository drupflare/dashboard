import { unsubscribeQuerySchema } from '../../../shared/notification-preferences';
import { defineApi } from '../../utils/define-api';

// a browser that follows the link in a mail lands on the page; nothing changes until it confirms
export default defineApi(
	{
		scope: 'public',
		action: 'notification.unsubscribe',
		rateClass: 'read',
		tags: ['me'],
		summary: 'Open the unsubscribe page',
		description:
			'Redirects to the page that asks you to confirm. Reading the link changes nothing, so a mail scanner that opens it does not unsubscribe anyone.',
		query: unsubscribeQuerySchema
	},
	async ({ query }) =>
		new Response(null, {
			status: 302,
			headers: { Location: `/unsubscribe/${encodeURIComponent(query.token)}` }
		})
);
