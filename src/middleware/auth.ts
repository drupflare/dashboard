export default defineNuxtRouteMiddleware(async (to) => {
	if (import.meta.server) return;

	const session = useSessionStore();
	// a hinted visitor probably has a session, so the organizations load beside /me
	await Promise.all([session.ensure(), session.hinted ? useOrgStore().ensure() : undefined]);
	if (session.me === null) {
		return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
	}
});
