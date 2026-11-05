import { defineEventHandler, setResponseHeaders } from 'h3';

// swagger-ui-dist files are served as public assets under this base; the layout is unverified
const SWAGGER_ASSETS = '/api/swagger-ui';
const SPEC_URL = '/api/openapi.json';

const INIT_SCRIPT = `window.ui = SwaggerUIBundle({ url: '${SPEC_URL}', dom_id: '#swagger-ui', deepLinking: true });`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drupflare API</title>
<link rel="stylesheet" href="${SWAGGER_ASSETS}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_ASSETS}/swagger-ui-bundle.js"></script>
<script>${INIT_SCRIPT}</script>
</body>
</html>
`;

async function contentSecurityPolicy(): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(INIT_SCRIPT));
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
	return [
		"default-src 'none'",
		`script-src 'self' 'sha256-${hash}'`,
		"style-src 'self'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'"
	].join('; ');
}

let policy: Promise<string> | undefined;

export default defineEventHandler(async (event) => {
	policy ??= contentSecurityPolicy();
	setResponseHeaders(event, {
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Security-Policy': await policy,
		'Cache-Control': 'public, max-age=300'
	});
	return PAGE;
});
