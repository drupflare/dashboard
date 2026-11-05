import type { Severity } from './vocab';

export const CATALOGUE_CLASSES = ['safe', 'rebuild', 'stateful'] as const;

export const CATALOGUE_AUTOMATION = ['auto', 'auto-with-guard', 'approval', 'manual'] as const;

export type CatalogueRow = {
	repairId: string;
	source: string;
	severity: Severity;
	handle: string;
	class: (typeof CATALOGUE_CLASSES)[number];
	automation: (typeof CATALOGUE_AUTOMATION)[number];
	preconditions: string[];
	attemptBound: number;
	cooldownMs: number;
	// re-observes the site after the repair and reports whether the failure cleared
	successPredicate: (observation: unknown) => boolean;
	undo: string | null;
	escalation: string;
};

// rows arrive in P4; until then every repair is uncatalogued
export const CATALOGUE: ReadonlyMap<string, CatalogueRow> = new Map<string, CatalogueRow>();

export class UncataloguedRepairError extends Error {
	constructor(repairId: string) {
		super(`repair ${repairId} has no catalogue row`);
	}
}

export function assertCatalogued(
	repairId: string,
	registry: ReadonlyMap<string, CatalogueRow> = CATALOGUE
): CatalogueRow {
	const row = registry.get(repairId);
	if (!row) throw new UncataloguedRepairError(repairId);
	return row;
}
