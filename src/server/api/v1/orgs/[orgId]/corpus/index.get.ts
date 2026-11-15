import { z } from 'zod';
import { corpusSchema, corpusStatuses, searchCorpus } from '../../../../../../shared/corpus';
import corpusJson from '../../../../../../shared/corpus.json';
import { ApiError } from '../../../../../../shared/errors';
import { defineApi } from '../../../../../utils/define-api';

const manifest = corpusSchema.parse(corpusJson);

export default defineApi(
	{
		scope: 'organization',
		action: 'template.read',
		rateClass: 'read',
		tags: ['repos'],
		summary: 'Search the verified corpus of Drupal codebases',
		description:
			'Lists the codebases in the verified corpus with their status, whether each one can be installed and the reason when it cannot. Filter by part of the name or by status.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			q: z.string().max(100).optional(),
			status: z.enum(corpusStatuses).optional()
		}),
		response: z.object({
			rows: z.array(z.string()),
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					status: z.enum(corpusStatuses),
					install: z.union([
						z.object({ allowed: z.literal(true) }),
						z.object({ allowed: z.literal(false), reason: z.string() })
					]),
					cells: z.record(
						z.string(),
						z.object({ state: z.string(), note: z.string().optional() })
					)
				})
			)
		})
	},
	({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { rows: manifest.rows, items: searchCorpus(manifest, query) };
	}
);
