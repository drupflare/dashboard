export type RollbackOffer = 'restore-data-with-code' | 'fix-forward';

export interface RollbackTarget {
	schemaVersion: number;
	// the highest data schema the target code can run against
	acceptsSchema: number;
}

export type RollbackVerdict =
	{ allowed: true } | { allowed: false; reason: string; offers: RollbackOffer[] };

export const ROLLBACK_OFFERS: RollbackOffer[] = ['restore-data-with-code', 'fix-forward'];

export function guardRollback(input: {
	dataSchemaVersion: number | null;
	target: RollbackTarget;
}): RollbackVerdict {
	const { dataSchemaVersion, target } = input;
	if (dataSchemaVersion === null) {
		return {
			allowed: false,
			reason: "We can't tell which data version this site is on, so rolling back the code alone isn't safe. Restore the data together with the code, or fix the problem in a new release.",
			offers: [...ROLLBACK_OFFERS]
		};
	}
	if (dataSchemaVersion > target.acceptsSchema) {
		return {
			allowed: false,
			reason: 'The current release changed how this site stores its data, and the earlier code cannot read that. Rolling back the code alone would break the site. Restore the data together with the code, or fix the problem in a new release.',
			offers: [...ROLLBACK_OFFERS]
		};
	}
	return { allowed: true };
}
