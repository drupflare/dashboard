# Browser end-to-end tests

Playwright tests against the production build, run in Chromium at desktop and Pixel 7 widths.

## Run

Build the test build once, then run the suite:

```sh
bun run build:test
bun run test:e2e
```

`test:e2e` starts `wrangler dev` against `.output/server/wrangler.json` on `http://localhost:8787`, or reuses a server already on that port. Set `E2E_PORT` to change the port, or `E2E_BASE_URL` to point at another server.

Rebuild after any change under `src/`, because the suite tests the build in `.output`, not the source.

## What it covers

- `public.spec.ts`: public pages render signed out, with one `h1`, the expected `<title>`, no console errors and no failed same-origin requests.
- `pages.spec.ts`: every static page in `src/pages`, signed in, at 390 px. Checks status below 500, a visible `main`, no horizontal scroll, no raw error code and no console errors. Dynamic routes are skipped.
- `a11y.spec.ts`: every static page at 390 and 1280 px, light and dark. Checks the skip link, focus rings, no navigation after load, and axe at `serious` and `critical`. Admin pages run as a platform admin with `/api/v1/admin/**` stubbed by `page.route`, because that API needs a Cloudflare Access login the local build cannot supply. Each is audited with one row, with none, and while its requests are pending. JSON reports land in `test-results/a11y`.
- `keyboard.spec.ts`: the login form and the first step of the new-site flow are reached by Tab, show a focus ring, and do not trap focus.

## Sign-in

The signed-in fixture writes a user row and a session into the local build's persisted state (`.output/server/.wrangler/state/v3`) with `wrangler`'s `getPlatformProxy`. It makes no Cloudflare API call. `scripts/mint-session.ts` is not used here: it signs in against the stage D1 and KV through the Cloudflare API.

The session cookie is sent as a `cookie` header on each request of the test context, because a `__Host-` cookie cannot be set from a URL in Playwright.

## Not covered

- The approved-worker round trips on the docker plane and the real stage plane. The nightly job runs these once their scripts exist.
- Live Cloudflare calls of any kind. No `live:*` script exists.
- Form submission. The keyboard tests reach the controls but do not send a sign-in code or create a site.
