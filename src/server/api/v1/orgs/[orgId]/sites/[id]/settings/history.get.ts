import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { SITE_CONFIG_REGISTRY } from '../../../../../../../../shared/site-config/registry';
import { permittedActions } from '../../../../../../../domain/authorize';
import { siteSettingsServices } from '../../../../../../../services/site-settings';
import {
	listSettingsHistory,
	settingChangeView,
	toSettingChangeView
} from '../../../../../../../services/site-settings-write';
import { defineApi } from '../../../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'site',
		action: 'site.config.runtime.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the settings changes of a site',
		description:
			'Lists the settings changes made through the platform for the site in the path, newest first. Only changes to settings of a group the caller may read are listed, and a secret shows only whether it was set. A change says whether the site reported the new value back and whether it can be reverted.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({
			items: z.array(settingChangeView),
			nextCursor: z.string().nullable()
		})
	},
	async ({ principal, resource, params, query, facts }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			facts === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const rows = await listSettingsHistory(siteSettingsServices(), {
			orgId,
			siteId: resolved,
			after,
			count: limit + 1,
			permitted: permittedActions({ principal, resource, facts })
		});
		const page = toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
		return {
			items: page.items.map((row) =>
				toSettingChangeView(row, (key) => SITE_CONFIG_REGISTRY[key]?.label ?? key)
			),
			nextCursor: page.nextCursor
		};
	}
);
