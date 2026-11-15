import { z } from 'zod';
import {
	PITR_WINDOW_DAYS,
	RESTORE_LAYER_FACTS,
	type RestoreLayerOffer,
	type RestorePoint
} from '../../shared/restore-points';
import { decodeCursor, toPage } from '../utils/pagination';
import { type BackupServices, listSiteBackups } from './backups';

const cursorShape = z.object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) });

export interface RestorePointPage {
	items: RestorePoint[];
	nextCursor: string | null;
	layers: RestoreLayerOffer[];
}

export async function listRestorePoints(
	services: BackupServices,
	input: { orgId: string; siteId: string; cursor?: string; limit: number }
): Promise<RestorePointPage> {
	const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor, cursorShape);
	const rows = await listSiteBackups(services, {
		orgId: input.orgId,
		siteId: input.siteId,
		after,
		count: input.limit + 1
	});
	const page = toPage(rows, input.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
	return {
		items: page.items.map((row) => ({
			id: row.id,
			layer: 'export',
			createdAt: new Date(row.createdAt).toISOString(),
			label: row.label,
			verified: row.verified,
			moves: [...RESTORE_LAYER_FACTS.export.moves],
			doesNotMove: [...RESTORE_LAYER_FACTS.export.doesNotMove]
		})),
		nextCursor: page.nextCursor,
		layers: [
			{
				layer: 'pitr',
				windowDays: PITR_WINDOW_DAYS,
				moves: [...RESTORE_LAYER_FACTS.pitr.moves],
				doesNotMove: [...RESTORE_LAYER_FACTS.pitr.doesNotMove]
			}
		]
	};
}
