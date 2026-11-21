// only declared public pages call this; the page runtime stays off unless SPOOL is on
export function useSpool() {
	if (!useRuntimeConfig().public.spool) return;
	useHead({
		script: [{ src: '/client.js', defer: true, 'data-spool-client': '' }]
	});
}
