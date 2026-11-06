import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';

export interface OrganizationServices {
	getDb: () => Promise<CollegeDBClient>;
}

let installed: OrganizationServices | null = null;

export function setOrganizationServices(services: OrganizationServices | null): void {
	installed = services;
}

export function organizationServices(): OrganizationServices {
	if (installed === null) throw new ApiError('not_built', 'Organisations are not available yet');
	return installed;
}
