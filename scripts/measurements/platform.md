# Platform Measurements

Recorded 2026-11-05 against Nuxt 4.6.2, Nitro 2.13.5, `@nuxt/content` 3.16, `@nuxthub/core` 0.10.11 and wrangler 4.152. Each section answers one question about the platform the dashboard runs on or deploys to.

## NuxtHub and `wrangler.jsonc`

Measured with `bun run build`, reading `.output/server/wrangler.json`.

- The output keeps every binding from `wrangler.jsonc` unchanged. Nitro adds `main`, `assets` and the `no_nodejs_compat_v2` flag.
- `hub: { db: 'sqlite', kv, blob, cache }` selects drivers only. It added no binding of its own, and `hub:db` reported the `d1` driver without a `DB` binding in the output. `DB` has to be declared in `wrangler.jsonc`.
- `@nuxt/content` fails the build without `better-sqlite3`. `content.experimental.nativeSqlite: true` builds with Node 24's `node:sqlite` instead.
- Open: whether a prerendered docs site needs a D1 binding at runtime. This needs real `/docs/**` pages to test.

## Extra Durable Object and Workflow exports from Nitro's entry

Not possible on the default path. A custom `nitro.entry` that re-exports `nitropack/presets/cloudflare/runtime/cloudflare-module` and adds `DurableObject` and `WorkflowEntrypoint` classes fails to build: `#nitro-internal-pollyfills` is not resolvable from the preset's runtime file, with or without `externals.inline`. Nitro's cloudflare handler exposes `scheduled`, `queue` and `tail` through hooks only.

So the engine (Durable Objects, Workflows, the Container class and queue consumers) is a second Worker in this repo with its own `wrangler.jsonc`, and `@cloudflare/workers-oauth-provider` is not used. A post-build hook that appends re-exports to `.output/server/index.mjs` might work and was not tried.

## OpenAPI from file routes

Run with `nitro.experimental.openAPI` on `nuxt dev`, reading `/_openapi.json`. A route that passes literals to `defineRouteMeta` shows up (`summary: 'Health'` appeared). The same call with `responses: { 200: response }`, where `response` is a `const` in the file, produced `"responses": {}`: the macro drops a variable reference without an error. It cannot carry schemas built from zod, so a `gen:openapi` script writes the committed spec instead.

In dev, `hub:db` with the `sqlite` and `d1` drivers failed with `Cannot find package '@libsql/client'` imported by `drizzle-orm/libsql`, so that package is a dependency.

## The v1.0.4 worker as a Workers for Platforms user Worker

Run on 2026-11-05 on a test account: dispatch namespace `drupflare-stage`, a script built from tag `v1.0.4` (`4cd73e1`) with the `wrangler.managed.jsonc` shape (no `FLEET_DB`, per-script KV and R2), reached through a throwaway dispatch Worker. Everything created for the run, apart from the namespace, was deleted afterwards.

As shipped, every request that is not a static asset throws.

| Request                      | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/robots.txt` (static asset) | 200 in 0.6 s                                                                                                              |
| `/health`                    | 401 (owner-protected, expected)                                                                                           |
| `/`                          | error 1101, then 502 from the dispatch Worker with `This Worker is not permitted to access the default cache.` after 9 ms |

Cause: `src/site/target.ts:52` evaluates `caches.default` while building the front context for every dynamic request, and on a namespaced script the property access itself throws. Cloudflare's Workers for Platforms limits page says `caches.default` is disabled for namespaced scripts. Other direct uses behind it are `src/site/edge-read.ts` (generation read, lane priming, page match through the context's `cache`), `src/site/files.ts:76` and `:170`, and `src/do/packages.ts:42`. The `PAGE_KV` tier and the Durable Object's own table are the existing substitutes. No p50 or p95 comparison was possible because no page rendered.

### With `CACHE_API=off`

A `CACHE_API` variable, set to `off` only in `wrangler.managed.jsonc`, sends the direct `caches.default` uses through one helper (`src/ops/cache-api.ts`). The helper returns a stand-in cache that misses every read and drops every write. It is in the worker repository and ships with the next worker release (v1.0.5). The helper also falls back to the stand-in when reading the property throws.

With the change, the same v1.0.4 bundle renders as a user Worker.

- Fresh site: the first request returned 503 with `x-cfw-migrate: starting`, the next `40/74` (the database replay), and the front page returned 200 within about 2 s of polling after that.
- A control arm ran the same bundle as a normal Worker on `workers.dev`, with `CACHE_API` unset and its own KV namespaces. 40 interleaved warm requests to the front page per arm, from one client:

| Arm                                                          | p50    | p95    | max    |
| ------------------------------------------------------------ | ------ | ------ | ------ |
| Workers for Platforms user Worker, through a dispatch Worker | 0.59 s | 1.19 s | 36.2 s |
| Normal Worker, `workers.dev`, Cache API on                   | 0.80 s | 1.45 s | 35.7 s |

- No difference is established. The arms take different routes (the user Worker arm has an extra dispatch hop), the client time includes its own network and a new TLS connection per request, n is 40 from one location, and each arm has one outlier near 36 s that was not examined. Warm responses carried `x-cfw-cache: HIT` and `x-cfw-do-cache: HIT`. The tier that answered each sample was not recorded per arm, so the result cannot say how much the missing `caches.default` costs on a cold isolate or across locations. The dispatch Worker's own timing header read higher than the client's total time for the same request, so it was discarded.
- Not run: ring promotion and re-upload rollback, the recovery pass, a Durable Object storage check, and deployed compatibility fixtures.

## Per-site resources and managed bindings

Measured on the same run.

- The upload to the dispatch namespace accepted every managed binding: both Durable Object classes with migrations `v1` and `v2`, two KV namespaces, the R2 bucket, `send_email` (unrestricted), `version_metadata`, `assets`, the vars, the module rules and the alias. Startup time was 84 ms for the first script and 50 ms for the second.
- The `triggers.crons` block was accepted at upload. Whether the `*/5` schedule fires on a user Worker was not observed, and the namespace scripts API did not return a schedule. Cloudflare's documentation says nothing about cron for dispatch namespaces either.
- `FLEET_DB` was left out and the site served pages, so the page-serving path does not need it. The inventory features that read it were not exercised.
- `send_email` and `version_metadata` were accepted at upload. Cloudflare's documentation names neither for user Workers, so the upload is the only evidence, and no mail was sent.
- Assets: 4,339 files uploaded per script, 246 skipped as duplicates inside the payload. A second script from the same payload re-uploaded all 4,339 files, so nothing dedupes across scripts. First script: 34.7 s for the asset session (one retry) and 44.0 s total. Second script: 14.3 s and 23.4 s total.
- Delete latency: script 0.41 s, KV namespace 0.21 s, R2 bucket 0.93 s. Create latency: KV namespace 0.55 s and 0.48 s, R2 bucket 0.65 s.
- Asset session with the cache change applied: 23.2 s for the user Worker script and 17.2 s for the control Worker.
- Cloudflare API rate limit (documentation search summary): 1,200 requests per five minutes per user, cumulative across dashboard, API key and token traffic. The token table's "per user/account token" wording is ambiguous, so whether the limit is per token or per user is not settled.
- Worker size (documentation search summary): 64 MiB uncompressed and no compressed limit. The v1.0.4 managed bundle is 17.3 MiB.
- Account limits, from Cloudflare's documentation through search summaries (the fetch tool returned no full text), read on 2026-11-05: KV namespaces 1,000 per account (more cost $0.10 a month each); R2 buckets 100,000 by default; D1 databases 1,000,000 on Workers Paid with 100,000 included; Workers for Platforms scripts and Durable Object namespaces unlimited; Workers Static Assets 100,000 files per version on Workers Paid and 25 MiB per file.
- Per-account tenant ceiling: two KV namespaces per site gives 500 sites on the default KV limit, below the storage-based estimate of about 1,083. KV namespaces are the first limit to hit.

## Time to stop serving after a revoke

Run on 2026-11-06 against the stage dispatch Worker (`drupflare-dispatch-stage`, deployed from the working tree, not a commit). The tenant is a script that answers a static 200 page. Each trial uses one site on a proxied `drupflare.app` host. The site is probed at 5 requests a second for 60 s, revoked through the signed control route, then probed for 60 s more. There are 10 trials per arm. The stale window runs from the acknowledgement of the revoke request to the end of the last 2xx response after it, so it includes one round trip.

| Arm                                          | Stale window p50 | p95        | max        | Warm latency p50 | p95      |
| -------------------------------------------- | ---------------- | ---------- | ---------- | ---------------- | -------- |
| Per request (every request asks `SITE_AUTH`) | 0 ms             | 0 ms       | 0 ms       | 48.4 ms          | 117.6 ms |
| Lease (30 s leases)                          | 235.0 ms         | 1,048.7 ms | 1,048.7 ms | 36.0 ms          | 72.5 ms  |
| Hybrid (1 strict site of 10)                 | 33.5 ms          | 315.0 ms   | 315.0 ms   | 35.0 ms          | 112.6 ms |

- Warm latency is client time over 3,000 probes per arm, from one client. The per-request arm's p50 is 12.3 ms above the lease arm's and its p95 is 45.1 ms above. Each arm has a maximum above 500 ms (5,105.6 ms, 1,324.6 ms and 535.4 ms) that was not examined.
- At n = 10 the p95 equals the maximum in every arm.
- Every probe, 6,000 per arm, reached the IAD colo. A colo that cached an earlier answer was not tested, and neither was a second client location. No bound is stated from this reading.
- The lease arm's windows are far below the 30 s lease. This reading does not say why.
- The control site gave no baseline. Its host is the control host, which answers 405 to a GET, so all 18,000 control probes were non-2xx.
- Spend was not read from the billing meter. The script's list-price estimate for the run is $0.0116.

## Counting views

Run on 2026-11-06 against the same stage dispatch Worker and a tenant that answers a 200 `text/html` page and counts each request in its own Durable Object. Each trial uses one site: 3,000 requests at 50 a second, then 20 s to settle, with batches of 50 and a 5 s flush. There are 10 trials per arm, and the odd trials call a stage-only route that allocates past the 128 MB memory limit partway through. A control site with counting off was probed at the same moments (90,000 requests, 4 non-2xx, trial p50 70.6 ms, n = 30). Everything came from one client in one location.

"Short" below is the tenant's own count minus the counter's count for the same trial.

| Arm           | Added p50 per trial (min, p50, max) | Short, clean trials (n = 5) | Short, terminated trials (n = 5) |
| ------------- | ----------------------------------- | --------------------------- | -------------------------------- |
| Write-through | -1.9, 14.0, 27.7 ms                 | 0 in all five               | 1 view in one trial, 0 in four   |
| Batched       | -19.7, -10.6, 1.6 ms                | p50 143 (78 to 295)         | p50 133 (106 to 188)             |
| Hybrid        | -18.6, -9.7, 1.4 ms                 | p50 39 (24 to 121)          | p50 61 (8 to 180)                |

- Write-through waits for the counter before the response returns. Its added p95 per trial had a p50 of 37.5 ms and a maximum of 59.9 ms. Batched and hybrid showed negative added p50 against the control, so the control is not an exact baseline here. Against batched, which does not wait, write-through is 24.6 ms higher at the p50.
- Batched fell short in every trial, by 2.6 to 9.8 percent of 3,000. Hybrid fell short in every trial too, by 0.3 to 6.0 percent. The shortfall also appears in the number of views the isolates reported as issued, so the counter holds no gap that would mark the hour estimated. Under the ledger's rule that an hour whose acknowledged and issued counts match is exact, these hours would read exact while short. This follows from the rule and the counts. No ledger run was made.
- Each trial saw 9 to 30 different isolate origins. A shortfall of a few tens of views per origin would account for the totals. That was not tested.
- The run does not show that the memory route ends an isolate. The shortfalls of clean and terminated trials overlap.
- Not measured: the counter object's request and row counts. The statistics it keeps in memory read zero in every trial, so the object had been evicted before the read. The cost of each mechanism rests on the dry-run arithmetic and not on a meter reading.

## Serving a Drupal site without the Cache API

Run on 2026-11-06 on a Drupal site built from worker commit `edd7f09234` with `wrangler.managed.jsonc` (`CACHE_API=off`, `PLAN=free`), uploaded by hand to the stage namespace and reached through the stage dispatch Worker. No dashboard or engine was deployed, so the site was created without them. One client in one location, and every response came through the IAD colo.

- First requests on the new site: 503 with `x-cfw-migrate: starting`, then 503 at `40/74` during the database replay, then a 200 rendered in 4,540 ms (`x-cfw-serve-ms`). Later requests were cache hits.
- Warm, 100 requests per path after 5 warm-up requests, client time:

| Path               | p50     | p95     | max     | Answered by                      |
| ------------------ | ------- | ------- | ------- | -------------------------------- |
| `/`                | 44.8 ms | 60.3 ms | 78.8 ms | 97 isolate memory, 3 object hits |
| `/user/login`      | 45.2 ms | 60.3 ms | 94.2 ms | 100 isolate memory               |
| a path that is 404 | 62.5 ms | 80.7 ms | 94.7 ms | 100 object hits                  |

- After 10 minutes with no requests, six requests to `/` took 1,214 ms (object hit), 186 ms (`PAGE_KV`), then 70, 46, 44 and 61 ms (isolate memory). That is one sequence, so n = 1 per position.
- No response was answered by `caches.default`. `x-cfw-edge` read `MEM` or `MISS` throughout.
- Not established: what the missing Cache API costs, because this run has no control arm with it on. The worker's published serving figures were measured inside a rig and are not comparable with client time through the dispatch Worker, so no comparison to them is made. Several colos and a cold isolate in a second location were not tested.

## Settings discovery on a deployed Drupal site

Run on 2026-11-06 against the same stage site after its first-run call, with the owner token the call returned. The dashboard's discovery code read `GET /settings` and composed the discovery document.

- The document passes the discovery contract. It holds 32 settings, each with a value, a provenance and a writable flag, plus 6 routes. Its capabilities list is empty, because the composer does not fill it from `/settings`.
- One write round trip on a numeric setting (`LAZY_FS_BUDGET_BYTES`, 4,194,304): a write with the current value as its snapshot succeeded and the next read returned the new value. A write sent with the old value as its snapshot came back as a conflict that carried the server's value. A revert restored the original value. The worker serves no `ETag`, so the conflict comes from the dashboard's own comparison against a fresh read and not from `If-Match`.
- Only the Drupal worker was tested. The first-party Worker templates deploy unmodified and serve no discovery document, so nothing about them was run.
