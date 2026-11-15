import { z } from 'zod';
import {
	corpusSchema,
	corpusSourcesSchema,
	corpusStatuses,
	searchCorpus
} from '../../../../../../shared/corpus';
import sourcesJson from '../../../../../../shared/corpus-sources.json';
import corpusJson from '../../../../../../shared/corpus.json';
import { ApiError } from '../../../../../../shared/errors';
import { defineApi } from '../../../../../utils/define-api';

const manifest = corpusSchema.parse(corpusJson);
const sources = corpusSourcesSchema.parse(sourcesJson);

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
					title: z.string(),
					summary: z.string(),
					repo: z.string().nullable(),
					core: z.string().nullable(),
					shape: z.string().nullable(),
					status: z.enum(corpusStatuses),
					install: z.union([
						z.object({ allowed: z.literal(true) }),
						z.object({ allowed: z.literal(false), reason: z.string() })
					]),
					checks: z.object({
						passed: z.number(),
						total: z.number(),
						unchecked: z.number()
					}),
					blockers: z.array(
						z.object({ checks: z.array(z.string()), reason: z.string() })
					),
					legacy: z.object({ date: z.string(), baseOnly: z.boolean() }).nullable(),
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
		return { rows: manifest.rows, items: searchCorpus(manifest, query, sources) };
	}
);
