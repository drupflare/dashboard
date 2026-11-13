import { preflightBodySchema, preflightResultSchema } from '../../../shared/preflight';
import { preflightServices, runPreflight } from '../../services/preflight';
import { defineApi } from '../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'migrate.preflight',
		rateClass: 'preflight',
		tags: ['imports'],
		summary: 'Read what a site shows from outside',
		description:
			'Reads the home page of a public site and up to three small files on the same host, then reports the system and version the site discloses, where it appears to be hosted and what it could not tell. It never says a site is compatible. A refusal names the reason in details.reason.',
		body: preflightBodySchema,
		response: preflightResultSchema
	},
	({ body }) => runPreflight(preflightServices(), body.url)
);
