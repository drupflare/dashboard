import type { CounterClient } from './counting';

export type View = { siteId: string; host: string; status: number; serving: string };

type Dataset = {
	writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
};

// one counter object per site, named by the site id
export function counterFor<Id>(
	namespace: { idFromName(name: string): Id; get(id: Id): unknown },
	siteId: string
): CounterClient {
	return namespace.get(namespace.idFromName(siteId)) as unknown as CounterClient;
}

// best effort: a missing dataset or a failed write never changes the response
export function writeView(dataset: Dataset | undefined, view: View): void {
	try {
		dataset?.writeDataPoint({
			indexes: [view.siteId],
			blobs: [view.host, view.serving],
			doubles: [view.status]
		});
	} catch {
		// dropped on purpose
	}
}
