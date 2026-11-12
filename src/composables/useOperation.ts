import type { Operation } from '@contracts/operations';
import type { Ref } from 'vue';
import { toApiClientError, type ApiClientError } from '~/composables/useApi';
import { usePoll, type PollOptions } from '~/composables/usePoll';
import { useOperationsStore } from '~/stores/operations';

const TERMINAL: ReadonlySet<Operation['status']> = new Set([
	'succeeded',
	'failed',
	'cancelled',
	'rolled-back'
]);

function isTerminal(status: Operation['status']): boolean {
	return TERMINAL.has(status);
}

export function useOperation(orgId: Ref<string | null>, id: string, options: PollOptions = {}) {
	const store = useOperationsStore();
	const operation = ref<Operation | null>(null);
	const error = ref<ApiClientError | null>(null);
	const missing = ref(false);

	const poll = usePoll(async () => {
		const org = orgId.value;
		if (!org) return;
		try {
			const next = await store.fetchOne(org, id);
			error.value = null;
			if (next === null) {
				missing.value = true;
				poll.stop();
				return;
			}
			operation.value = next;
			if (isTerminal(next.status)) poll.stop();
		} catch (failure) {
			error.value = toApiClientError(failure);
		}
	}, options);

	watch(
		orgId,
		(value) => {
			if (value) poll.start();
		},
		{ immediate: true }
	);

	return { operation, error, missing, refresh: poll.refresh };
}
