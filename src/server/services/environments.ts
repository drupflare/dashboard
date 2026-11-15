import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import { listEnvironments, type EnvironmentRecord } from '../db/repos/environments';
import { getReadySite } from '../db/repos/sites';
import { siteServices } from './sites';

export async function listSiteEnvironments(input: {
	orgId: string;
	siteId: string;
}): Promise<EnvironmentRecord[]> {
	const db: CollegeDBClient = await siteServices().getDb();
	if ((await getReadySite(db, input.orgId, input.siteId)) === null) {
		throw new ApiError('not_found', 'Not found');
	}
	return listEnvironments(db, input.orgId, input.siteId);
}
