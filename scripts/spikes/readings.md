# Phase 0 Spike Readings

Recorded 2026-11-05 against Nuxt 4.6.2, Nitro 2.13.5, `@nuxt/content` 3.16, `@nuxthub/core` 0.10.11, wrangler 4.152.

## S3, NuxtHub and `wrangler.jsonc`

Measured with `bun run build`, reading `.output/server/wrangler.json`.

- The output keeps every binding from `wrangler.jsonc` unchanged. Nitro adds `main`, `assets` and the `no_nodejs_compat_v2` flag.
- `hub: { db: 'sqlite', kv, blob, cache }` selects drivers only. It added no binding of its own, and `hub:db` reported the `d1` driver without a `DB` binding in the output. `DB` therefore has to be declared in `wrangler.jsonc`, which matches the plan's rule.
- `@nuxt/content` fails the build without `better-sqlite3`. `content.experimental.nativeSqlite: true` builds with Node 24's `node:sqlite` instead.
- Open: whether a prerendered docs site needs a D1 binding at runtime. Not testable until `/docs/**` pages exist.

## S2, extra Durable Object and Workflow exports from Nitro's entry

Not met on the default path. A custom `nitro.entry` that re-exports `nitropack/presets/cloudflare/runtime/cloudflare-module` and adds `DurableObject` and `WorkflowEntrypoint` classes fails to build: `#nitro-internal-pollyfills` is not resolvable from the preset's runtime file, with or without `externals.inline`. Nitro's cloudflare handler exposes `scheduled`, `queue` and `tail` through hooks only.

Decision under the plan's own fallback: the engine (Durable Objects, Workflows, Container class, queue consumers) becomes a second Worker in this repo with its own `wrangler.jsonc`, and `@cloudflare/workers-oauth-provider` is dropped. A post-build hook that appends re-exports to `.output/server/index.mjs` might work and was not tried.

## S10, OpenAPI from file routes

Run with `nitro.experimental.openAPI` on `nuxt dev`, reading `/_openapi.json`. A route that passes literals to `defineRouteMeta` shows up (`summary: 'Health'` appeared). The same call with `responses: { 200: response }`, where `response` is a `const` in the file, produced `"responses": {}`: the macro drops a variable reference without an error. So it cannot carry schemas built from zod, and the plan's default stands: a `gen:openapi` script that writes the committed spec. Not run: the production route (`/api/openapi.json`) and the script itself, which is P1 work.

Also seen in the dev log: `hub:db` with the `sqlite` and `d1` drivers fails in dev with `Cannot find package '@libsql/client'` imported by `drizzle-orm/libsql`, so P1's data lane has to add that package or choose another dev driver.

## S1, the v1.0.4 worker as a WfP user Worker

Run on 2026-11-05 on account `gmitch215`: dispatch namespace `drupflare-stage`, script `s-spike1` built from tag `v1.0.4` (`4cd73e1`) with the `wrangler.managed.jsonc` shape (no `FLEET_DB`, per-script KV and R2), reached through a throwaway dispatch Worker. Everything created for the run, apart from the namespace, was deleted afterwards.

Result: fails as shipped. Every request that is not a static asset throws.

| Request                      | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/robots.txt` (static asset) | 200 in 0.6 s                                                                                                              |
| `/health`                    | 401 (owner-protected, expected)                                                                                           |
| `/`                          | error 1101, then 502 from the dispatch Worker with `This Worker is not permitted to access the default cache.` after 9 ms |

Cause: `src/site/target.ts:52` evaluates `caches.default` while building the front context for every dynamic request, and on a namespaced script the property access itself throws. The WfP limits page says `caches.default` is disabled for namespaced scripts. Other direct uses behind it: `src/site/edge-read.ts` (generation read, lane priming, page match through the context's `cache`), `src/site/files.ts:76` and `:170`, `src/do/packages.ts:42`. The `PAGE_KV` tier and the Durable Object's own table are the existing substitutes. No p50 or p95 comparison was possible because no page rendered, and the claim, warm and recovery steps were not reached.

Consequence: a managed Drupal site cannot serve until the worker stops touching the Cache API there.

### Rerun with a `CACHE_API=off` patch

Patch: `build/lanes/p0/worker-cache-api.patch` (gitignored, applies cleanly to the worker tree, not applied). A new `CACHE_API` var, set to `off` only in `wrangler.managed.jsonc`, makes the four direct `caches.default` uses go through one helper (`src/ops/cache-api.ts`) that returns a stand-in cache which misses every read and drops every write. The worker's one-click spec now allows that one managed-only var, and a new spec covers the helper. Both specs pass (9 tests) and `tsc` is clean. The rest of the worker's test suite was not run.

Result: passes. The patched script (same v1.0.4 bundle plus the patch) renders.

- Fresh site: the first request returned 503 with `x-cfw-migrate: starting`, the next `40/74` (the database replay), and the front page returned 200 within about 2 s of polling after that.
- A control arm ran the same bundle as a normal Worker on `workers.dev`, with `CACHE_API` unset and its own KV namespaces. 40 interleaved warm requests to the front page per arm, from one client:

| Arm                                        | p50    | p95    | max    |
| ------------------------------------------ | ------ | ------ | ------ |
| WfP user Worker, through a dispatch Worker | 0.59 s | 1.19 s | 36.2 s |
| Normal Worker, `workers.dev`, Cache API on | 0.80 s | 1.45 s | 35.7 s |

- No difference is established. The arms take different routes (the WfP arm has an extra dispatch hop), the client time includes its own network and a new TLS connection per request, n is 40 from one location, and each arm has one outlier near 36 s that was not examined. Warm responses carried `x-cfw-cache: HIT` and `x-cfw-do-cache: HIT`. The dispatch Worker's own `x-s1-dispatch-ms` header read higher than the client's total time for the same request, so it was discarded.
- Not run: ring promotion and re-upload rollback, the recovery pass, a Durable Object storage check, and deployed compatibility fixtures.

## S19, per-site resources and managed bindings

Measured on the same run.

- The upload to the dispatch namespace accepted every managed binding: both Durable Object classes with migrations `v1` and `v2`, two KV namespaces, the R2 bucket, `send_email` (unrestricted), `version_metadata`, `assets`, the vars, the module rules and the alias. Startup time 84 ms (first script) and 50 ms (second).
- The `triggers.crons` block was accepted at upload. Whether the `*/5` schedule fires on a user Worker was not observed, and the namespace scripts API did not return a schedule. The docs survey found nothing on cron for dispatch namespaces either.
- `FLEET_DB` was left out and the patched site served pages, so the page-serving path does not need it. The inventory features that read it were not exercised.
- `send_email` and `version_metadata`: accepted at upload. The docs survey found neither named for user Workers, so the upload is the only evidence, and no mail was sent.
- Assets: 4,339 files uploaded per script, 246 skipped as duplicates inside the payload. A second script from the same payload re-uploaded all 4,339 files, so nothing dedupes across scripts. First script: 34.7 s for the asset session (one retry) and 44.0 s total. Second script: 14.3 s and 23.4 s total.
- Delete latency: script 0.41 s, KV namespace 0.21 s, R2 bucket 0.93 s. Create latency: KV namespace 0.55 s and 0.48 s, R2 bucket 0.65 s.
- Asset session on the patched run: 23.2 s for the WfP script and 17.2 s for the control Worker.
- Cloudflare API rate limit (docs survey, summary): 1,200 requests per five minutes per user, cumulative across dashboard, API key and token traffic. The token table's "per user/account token" wording is ambiguous, so S5 still has to settle per-token against per-user.
- Worker size (survey, summary): 64 MiB uncompressed and no compressed limit. The v1.0.4 managed bundle is 17.3 MiB.
- Account limits, from Cloudflare's docs through search summaries and a Haiku survey (`build/lanes/p0/docs-limits-results.md`, every row a summary because the fetch tool returned no full text), 2026-11-05: KV namespaces 1,000 per account (more cost $0.10 a month each); R2 buckets 100,000 by default; D1 databases 1,000,000 on Workers Paid with 100,000 included; WfP scripts and Durable Object namespaces unlimited; Workers Static Assets 100,000 files per version on Workers Paid and 25 MiB per file.
- Per-account tenant ceiling: two KV namespaces per site gives 500 sites on the default KV limit, below the roadmap's 1,083 by storage. KV namespaces are the first limit to hit.
