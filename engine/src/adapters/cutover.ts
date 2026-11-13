import type { CutoverDestination, CutoverPorts, CutoverSource } from '../ports';
import { PermanentError } from '../step';

const unavailable = () =>
	new PermanentError(
		'cutover_unavailable',
		'the source and destination adapters for a cutover are not built yet'
	);

// every call fails closed until the real adapters exist, so a started cutover stops before it changes anything
const refuse = async (): Promise<never> => {
	throw unavailable();
};

const source: CutoverSource = {
	lowerTtl: refuse,
	restoreTtl: refuse,
	snapshot: refuse,
	delta: refuse,
	applyWritePolicy: refuse,
	restoreWrites: refuse
};

const destination: CutoverDestination = {
	validate: refuse,
	promote: refuse,
	route: refuse,
	acceptedWrites: refuse,
	observe: refuse,
	exportChanges: refuse
};

export const unavailableCutoverPorts: CutoverPorts = {
	source: () => source,
	destination: () => destination
};
