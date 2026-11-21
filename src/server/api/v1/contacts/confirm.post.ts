import { z } from 'zod';
import { contactConfirmSchema } from '../../../../shared/contacts';
import { confirmContact, contactServices } from '../../../services/contacts';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'contact.confirm',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Confirm a contact address',
		description:
			'Marks a contact verified from the one-time link in its confirmation mail. The link works once and lasts seven days.',
		body: contactConfirmSchema,
		response: z.object({ verified: z.literal(true) })
	},
	async ({ body }) => {
		await confirmContact(contactServices(), body.token);
		return { verified: true as const };
	}
);
