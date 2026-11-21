import { vi } from 'vitest';
import { assembleOrganization, type BudgetRow } from '../../../../src/server/db/repos/budgets';
import { derive, type Entitlement } from '../../../../src/server/domain/entitlements';
import type { AuditInput } from '../../../../src/server/services/audit';
import type { BudgetEnforcementDeps } from '../../../../src/server/services/budget-enforcement';
import type { BudgetServices } from '../../../../src/server/services/budgets';

export const NOW = Date.UTC(2026, 10, 21, 12);
export const ORG = 'org-1';

export function entitlement(planId: string): Entitlement {
	const result = derive(planId);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
}

export function world(
	options: {
		plan?: string;
		sites?: string[];
		enforcement?: boolean;
		overageBilled?: boolean;
	} = {}
) {
	const rows: BudgetRow[] = [];
	const audits: { orgId: string; input: AuditInput }[] = [];
	const reevaluated: string[] = [];
	let plan = options.plan ?? 'managed-pro';
	const siteIds = options.sites ?? ['site-1', 'site-2'];
	let counter = 0;
	const sourceOf = (orgId: string) => {
		const found = rows.filter((row) => row.organizationId === orgId);
		return assembleOrganization({
			organizationId: orgId,
			entitlement: entitlement(plan),
			rows: found,
			siteIds
		});
	};
	const enforcement = vi.fn((): BudgetEnforcementDeps | null => {
		if (options.enforcement === false) return null;
		return {
			mode: 'shadow',
			now: () => NOW,
			source: {
				organizations: async () => [],
				organization: async (orgId) => {
					reevaluated.push(orgId);
					return null;
				}
			},
			counts: { monthViews: async () => 0 },
			authority: { applyBudgetState: async () => ({ outcome: 'unchanged', generation: 1 }) },
			ledger: { get: async () => null, set: async () => undefined },
			audit: async () => undefined,
			log: () => undefined
		};
	});
	const services: BudgetServices = {
		store: {
			async getOrg(orgId) {
				return rows.find((r) => r.organizationId === orgId && r.scope === 'org') ?? null;
			},
			async getSite(orgId, siteId) {
				return (
					rows.find(
						(r) =>
							r.organizationId === orgId && r.scope === 'site' && r.siteId === siteId
					) ?? null
				);
			},
			async put(row) {
				const at = rows.findIndex(
					(r) =>
						r.organizationId === row.organizationId &&
						r.scope === row.scope &&
						r.siteId === row.siteId
				);
				if (at >= 0) rows[at] = { ...row, id: rows[at]?.id ?? row.id };
				else rows.push(row);
			},
			async seed(row) {
				if (
					rows.some((r) => r.organizationId === row.organizationId && r.scope === 'org')
				) {
					return false;
				}
				rows.push(row);
				return true;
			},
			async alertsSent() {
				return [];
			}
		},
		source: {
			organizations: async () => [sourceOf(ORG)],
			organization: async (orgId) =>
				rows.some((r) => r.organizationId === orgId) ? sourceOf(orgId) : null
		},
		planOf: async () => entitlement(plan),
		audit: async (orgId, input) => {
			audits.push({ orgId, input });
		},
		enforcement,
		mode: () => 'shadow',
		overageBilled: () => options.overageBilled ?? false,
		newId: () => `bg_${++counter}`,
		now: () => NOW
	};
	// the evaluation is observed through the source it reads
	const reevaluateSpy = () => reevaluated;
	return {
		services,
		rows,
		audits,
		enforcement,
		reevaluated: reevaluateSpy,
		setPlan: (id: string) => {
			plan = id;
		}
	};
}
