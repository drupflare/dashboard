import { z } from 'zod';
import { siteServices } from '../../../../../services/sites';
import { startTemplateBuild } from '../../../../../services/templates';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.infrastructure.manage',
		rateClass: 'heavy',
		tags: ['admin'],
		summary: 'Build a template',
		description:
			'Starts a build of a template at the commit the corpus pins now. The build installs the template once and stores the result, so a new site can start from it. A second build of the same template is refused while one is running.',
		params: z.object({ entryId: z.string().min(1).max(40) }),
		response: z.object({ buildId: z.string() }),
		successStatus: 202
	},
	({ params }) => startTemplateBuild(siteServices(), params.entryId)
);
