export default defineNuxtRouteMiddleware(async (to) => {
	if (import.meta.server) return;

	const session = useSessionStore();
	await session.ensure();
	if (session.me === null) {
		return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
	}
});
