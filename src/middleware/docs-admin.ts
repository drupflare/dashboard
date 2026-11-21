import { isDocsAdminPath } from '~/shared/docs';

// the admin docs render only in the browser (routeRules ssr: false), so this check is the gate
export default defineNuxtRouteMiddleware(async (to) => {
	if (!isDocsAdminPath(to.path)) return;
	const session = useSessionStore();
	await session.ensure();
	if (session.me?.platformRole !== 'admin') {
		throw createError({ statusCode: 404, statusMessage: 'Page Not Found', fatal: true });
	}
});
