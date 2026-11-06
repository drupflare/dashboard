export default defineNuxtRouteMiddleware(async () => {
	if (import.meta.server) return;

	const session = useSessionStore();
	if (!session.me) return;
	await useOrgStore().ensure();
});
