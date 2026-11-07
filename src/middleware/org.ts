export default defineNuxtRouteMiddleware(async (to) => {
	if (import.meta.server) return;

	const session = useSessionStore();
	if (!session.me) return;
	const org = useOrgStore();
	await org.ensure();
	// the sites page reads the list, so its request starts before the page mounts
	if (to.path === '/sites' && org.current) void useSitesStore().load(org.current.id);
});
