import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';

const RELOAD_KEY = 'drupflare_admin_reload';

// access redirects a script request to its login, which fetch cannot follow; a page load can
function lacksAccess(error: ApiClientError): boolean {
	return error.code === 'network' || error.status === 403;
}

function markReload(): boolean {
	try {
		if (sessionStorage.getItem(RELOAD_KEY) !== null) return false;
		sessionStorage.setItem(RELOAD_KEY, '1');
		return true;
	} catch {
		return false;
	}
}

function clearReload(): void {
	try {
		sessionStorage.removeItem(RELOAD_KEY);
	} catch {
		// storage is off, so the reload never repeats
	}
}

// one reload per run of failures, so a call that still fails after it shows its error
export async function adminGet<T>(path: string, query?: Record<string, string>): Promise<T> {
	try {
		const result = await useApi().get<T>(path, query);
		clearReload();
		return result;
	} catch (error) {
		const failure = toApiClientError(error);
		if (import.meta.client && lacksAccess(failure) && markReload()) {
			window.location.assign('/admin');
			return new Promise<T>(() => undefined);
		}
		throw failure;
	}
}
