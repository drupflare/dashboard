import type { DispatchPlane } from '@drupflare/workforce';
import type { NamespaceKv } from '../ports';

// the value goes as the raw body; unverified against the live API
export function namespaceKvOf(plane: DispatchPlane): NamespaceKv {
	const path = (namespaceId: string, key: string) =>
		`/accounts/${plane.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
	return {
		async put(namespaceId, key, value) {
			const response = await plane.http.send(path(namespaceId, key), {
				method: 'PUT',
				body: value,
				headers: { 'content-type': 'text/plain' }
			});
			if (!response.ok) throw new Error(`PUT a KV value answered ${response.status}`);
		},
		async delete(namespaceId, key) {
			const response = await plane.http.send(path(namespaceId, key), { method: 'DELETE' });
			if (response.status === 404) return 'absent';
			if (!response.ok) throw new Error(`DELETE a KV value answered ${response.status}`);
			return 'deleted';
		}
	};
}
