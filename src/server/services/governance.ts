import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import type { Facts, Principal } from '../domain/authorize';
import type { AuditInput } from './audit';

export interface ReviewMailInput {
	orgName: string;
	scopeName: string;
	dueAt: string;
	reviewUrl: string;
}

// shared by service accounts, access reviews and offboarding
export interface GovernanceServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
	newId: () => string;
	// the standing of one member of the organisation, as the facts loader reads it
	ownerFacts: (orgId: string, userId: string) => Promise<Facts | null>;
	// the optional "ops" mail to reviewers; people who switched it off are skipped
	reviewMail: (
		orgId: string,
		input: ReviewMailInput
	) => Promise<{ sent: number; skipped: number }>;
}

let installed: GovernanceServices | null = null;

export function setGovernanceServices(services: GovernanceServices | null): void {
	installed = services;
}

export function governanceServices(): GovernanceServices {
	if (installed === null) throw new ApiError('not_built', 'This is not available yet');
	return installed;
}

export interface GovernanceActor {
	principal: Principal;
	userId: string;
	facts: Facts;
}

export function governanceActor(principal: Principal | null, facts: Facts | null): GovernanceActor {
	if (principal === null || facts === null) throw new ApiError('not_found', 'Not found');
	return {
		principal,
		userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
		facts
	};
}

export const iso = (at: number | null): string | null =>
	at === null ? null : new Date(at).toISOString();
