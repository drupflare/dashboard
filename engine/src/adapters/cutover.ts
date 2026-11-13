import type { CutoverPorts } from '../ports';
import { createCutoverDestination, type CutoverDestinationDeps } from './cutover-destination';
import { createCutoverSource, type CutoverSourceDeps } from './cutover-source';

export { CUTOVER_MISSING_CONTRACTS } from './cutover-destination';

export function cutoverPortsOf(deps: CutoverSourceDeps & CutoverDestinationDeps): CutoverPorts {
	return {
		source: (ref, orgId) => createCutoverSource(deps, ref, orgId),
		destination: (siteId) => createCutoverDestination(deps, siteId)
	};
}
