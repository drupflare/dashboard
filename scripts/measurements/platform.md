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

## Serving a site with the dashboard off

Run on 2026-11-07 against `jovial-iris-pier.drupflare.app`, a site the engine created on the stage namespace from worker commit `edd7f09234`. The run removed the custom-domain mapping for `app.drupflare.com` from the dashboard Worker, so the dashboard stopped answering, and put it back at the end. The dispatch Worker and the engine stayed deployed. One client in one location.

- Before: the dashboard health route answered 200 and the site's front page answered 200 in 2,322 ms for the first request of the run.
- With the mapping removed, `app.drupflare.com` answered 530 (origin DNS error) on every request, including the login page.
- The site answered 200 on every probe at 20 s, 60 s and 130 s after removal: the front page from cache (196, 647 and 980 ms), the login page (99, 75 and 141 ms), and an uncached `?cpoff=N` query that forced a render (593, 661 and 712 ms, `x-cfw-cache: RENDER`).
- After the mapping returned, the dashboard answered 200 again on the second poll and the site answered 200 as before.
- This shows that serving needs no request to the dashboard Worker. It does not show serving with the engine, the stage D1 database or the dispatch Worker unavailable. The dispatch Worker binds the dispatch namespace, its host KV, Analytics Engine and its own Durable Objects, and no D1 database and no service binding, which the configuration confirms and this run does not test.

## Creating, backing up, restoring and updating a site on the stage plane

Run on 2026-11-07 against the stage namespace with the engine and dashboard Workers redeployed from the working tree. The engine streams the asset and script uploads as multipart bodies written one slice at a time. Before this change the engine's logs hold two memory kills (128 MB limit) during creates, at 01:38 and 01:48 UTC on the same day, each followed by a replayed step; workforce encodes an asset to base64 one character at a time, which for the 13 MB asset builds a rope string of about 13 million nodes. One client, one site, one run each.

- Create (`calm-river-ash`, worker commit `edd7f09234`): succeeded in 5 min 9 s from start to the last step. All 11 steps ran on attempt 1. The engine's Observability logs for the window hold no memory error. `/firstrun` answered 503 once while the database unpacked, then 200 on the retry, so the owner token and the admin password were sealed and the password is unrevealed. The asset upload took 8 chunks in about 4 min 30 s.
- Health read through the dashboard (token unsealed, `/health` fetched through the site's hostname): 200 in 1.9 to 2.8 s, level `ok`, readiness `live`.
- Backup: succeeded in about 30 s, 2,601,188 bytes in 5 parts, restorable, not verified.
- Restore of that backup into another stage site: succeeded in about 20 s, the target answered 200 afterwards.
- Update to a second release (the first release plus one changed 57-byte asset): succeeded in about 30 s. The asset upload step sent 1 file. The front page and the changed asset answered 200, health read `ok`, the site's release record moved, and the script tags read `v:edd7f09235` and `m:v2`. A second update request answered 409 `up_to_date`.
- This shows that one create no longer hits the memory limit, and that these routes work on the plane for a small change. It does not show that the memory fix holds across many creates, because n = 1. It does not show an update that adds a Durable Object migration tag (the API's `old_tag` form has not run), the rollback after a failed update (covered by tests with injected failures only), or a delete (it needs a signed-in session with a fresh step-up, which no key can hold).

## Creating and restoring from the v1.0.5 tag, with releases read from the CDN

Run on 2026-11-07 against the stage namespace, with worker `v1.0.5` (commit `61431ae4c9`). The operation timestamps below come from the operation records; a watcher script's own log ran later on one run because its poll stalled, so the records are the figures. One client, one run per row.

- Release copy. The stage bundle was first built from the tag into the stage R2 bucket under `releases/61431ae4c9/` (4,346 objects, 68 MB). The first upload pass stored 3,129 objects and answered HTTP 429 (code 971) on 1,217, because the Cloudflare API limit is shared by the token and a D1 query made during the pass got the same answer. A slow retry pass stored the rest, and a bucket listing then showed all 4,346 keys (keys only, sizes not compared). Later the worker project published the same bundle to `https://cdn.drupflare.com/payloads/managed/releases/v1.0.5/` and the engine was switched to read from there. Checked from outside: the manifest and metadata checksums and all five module checksums match what the publisher stated, all 4,339 distinct assets answer 200 at the manifest sizes, 41 sampled assets hash to their keys, and the manifest passes the engine's `validateBundle` under the production limits.
- Creates, 11 steps each. Site A (R2 copy): 10 min 34 s, `Upload static assets` 592 s. Site B (R2 copy): 6 min 52 s, 364 s. Site C (CDN, release `v1.0.5`): 5 min 9 s, 270 s. The first-run call ran twice each (503 while the database unpacks, then success after 10 to 14 s). The engine's Observability logs hold no memory error in any of the three windows. With `calm-river-ash` above, that is four creates since the streaming change, none with a memory kill. The create time moved by a factor of two between runs and the asset step carries all of it; the cause was not found.
- Health read of A and B: level `ok`, readiness `live`. A's front page title reads "Welcome! | CFW Bench".
- Backup of A: succeeded, 2,601,899 bytes in 5 parts, restorable, not verified.
- Restore of that backup into B (created from the R2 copy): 11.8 s. Into C (created from the CDN): 7.8 s. Every step ran on attempt 1 and both targets answered 200, with health `ok`. A, B and C all start from the same seed content, so a 200 does not by itself tell a restored site from an unchanged one; the `Wait for the site to apply the dump` step is what records the import.
- Update. A request on a site that already runs the current release answered 409 `up_to_date`. Two updates failed in preflight with nothing changed. `ready-pine-yew` answered 401 on `/health`; the dashboard's stored owner token is probably stale, because I recovered that site's token with `/recover-token` during earlier owner-route checks and kept the new one only in a process (inferred, not checked). Site A to `v1.0.5` answered `release_not_found: no bundle manifest for 61431ae4c9`: the update reads the site's current release manifest to compare migration tags, and that release id exists only in the R2 copy, not on the CDN.
- This shows creates and restores work from the tagged build and from CDN objects alone. It does not show an update on the tagged build, because only one release exists on the CDN and a new site is already current. It does not show a delete or any signed-in screen (the Turnstile check on sign-in was left alone).

## Where the stage dashboard's API latency went

Run on 2026-11-07 from a laptop on eduroam (6 GHz, -64 dBm signal, 31 dB SNR), against the stage dashboard in the IAD colo. Client figures come from `curl` timings; Worker figures come from Workers Observability (`wallTimeMs`, `cpuTimeMs`, `clientTcpRtt`).

- Network. The gateway answered 20 of 20 pings, 8.7 ms average, 57 ms worst. Fresh HTTPS connections, 15 each, started answering after a median of 14 ms (Google), 24 ms (GitHub) and 27 ms (Cloudflare's edge). Static files from `app.drupflare.com` and `cdn.drupflare.com` started after a median of 69 and 105 ms. Two of 15 connections to `app.drupflare.com` stalled 1.5 to 6 s at TCP connect, which looks like a lost first packet; the cause was not isolated.
- D1. Four trivial queries ran in 0.1 to 0.25 ms of SQL each. The primary is in `ENAM`, read replication is off.
- Rate limiter. `nuxt-api-shield` ran on its defaults (12 requests per 108 s per route, then a 1-hour ban across every `/api` path, with a 1 s delay on each refusal) and did a KV read and write per request. Nitro's Cloudflare entry never sets the client address, so every counter key in the stage KV namespace ended in `unKnownIP`: all visitors shared one budget, and one burst of 25 requests from one machine banned the whole API until the ban key was deleted. Unauthenticated `/api/v1/me` took a median of 1,576 ms (min 258, max 2,610) before the module was removed, and 25 rapid calls afterwards took a median of 150 ms with no 429.
- Cold isolates. After that, about one request in three still took 1.1 to 1.5 s of Worker wall time with 70 to 150 ms CPU, against 3 to 11 ms for a warm one. The per-isolate schema check was 700 to 1,150 ms of it: `applySchema` ran about 40 `CREATE ... IF NOT EXISTS` statements and the triggers, one D1 round trip each, on every cold isolate. It now reads the stored version and a hash of the schema statements (and checks the append-only triggers exist) and runs the statements only when they differ. On cold isolates the check now takes 29 to 57 ms. Over 30 sequential `/api/v1/me` calls the client saw min 106, median 406, p90 701, max 852 ms, against p90 2,007 and max 2,140 ms in the 30-call run before the fix.
- Not shown. What the remaining 300 to 400 ms of a cold start is (module load and service boot), how long signed-in pages take end to end in a browser, and whether eduroam causes the TCP stalls.

## Running drangler's survey from a Worker over SSH

Run on 2026-11-12 in local workerd (`wrangler dev --local`) on a laptop, against the docker Drupal rig from drangler (Drupal 11.4.8, PHP 8.5.11, MariaDB, sshd on 127.0.0.1:2222), with `edgeport` 1.0.6. The Worker runs drangler's `runSurvey` unchanged (`src/migrate/survey.ts` imports only types from the transport and exec modules) over a small transport built on one edgeport SSH session, one `exec` per survey step. The reference is `drangler migrate survey` against the same box, written to JSON. Five Worker runs.

- All five dossiers deep-equal the reference on every field except `capturedAt`: PHP version and 47 extensions, Drupal 11.4.8, drush 13.8.1, MySQL driver, 38 enabled modules, 1 node, 4 image styles, 28 KB and 3 public files, no errors. Wall time 1,001, 1,091, 1,147, 1,163 and 1,498 ms for the 13 steps on a single connection.
- edgeport takes a hostname and a port and no connector, so a Worker can only reach an address `cloudflare:sockets` can open. This run proves the protocol, the key handling (an ed25519 key as PKCS8 PEM; I converted the OpenSSH key without testing whether edgeport accepts the OpenSSH format) and the survey logic inside the Workers runtime. It does not prove the network path from a Cloudflare address to a customer's server, and no public SSH host was opened for it.
- Streaming. `execStream` of `head -c N /dev/urandom` over the same session: 50 MB three times at 159, 172 and 171 MB/s, 500 MB twice at 181 and 174 MB/s. workerd's resident memory read 79 MB before the first run, 212 MB after the second 50 MB run, and 172 to 214 MB across the two 500 MB runs, so it did not grow with the transfer. This is loopback, so the rates say nothing about a real link, and local workerd does not enforce the 128 MB isolate limit, so the memory reading shows no growth with size and not that a Worker stays under its limit.
- The reference survey failed twice before it worked. The first run hit a changed host key for `[127.0.0.1]:2222` in the laptop's `known_hosts` from an earlier rig, and ran 13 steps at three attempts each. The second, a minute later, failed every step with "Connection closed by 127.0.0.1 port 2222"; a manual `ssh` with the same flags then worked and the third run passed. The cause of the second failure was not isolated (sshd refusing a burst of connections after the first run's 39 attempts is a guess). drangler opens one `ssh` process per step, where the Worker holds one session.

## Converting a database dump in a Worker, in chunks

Run on 2026-11-12 on the stage account. A standalone Worker (`spike-convert`, deleted after the runs) holds an R2 bucket and runs drangler's `convertDump` (MySQL to SQLite, `migrate/convert.ts`, unchanged) one range at a time. A step reads a byte range from R2, cuts it at the last `;` followed by a newline, converts it and writes the result under its own key, then answers with the offset of the next step. A client loop on a laptop drives the steps one after another over plain HTTP requests. This is not a Workflow, so it does not exercise a Workflow's step limits.

- Dumps. 50 MB and 500 MB are `mysqldump` output of a seeded MariaDB with a Drupal-shaped table. The 5 GB file (4,902 MB) is the 500 MB dump written out ten times in a row, because the database could not grow to 5 GB on this machine's disk. It tests size, not variety: every row is the same shape. Upload from the laptop to R2 through the Worker in 32 MB parts: 4,902 MB in 498 s, 9.84 MB/s, which is this laptop's link and says nothing about Cloudflare's.
- Correctness. In earlier local runs, converting in chunks cut at a statement boundary gave the same output as converting the whole dump, on `mysqldump` output, which writes one statement per physical line with newlines escaped. Another dump producer could put `;` and a newline inside a statement, and none was tested. The cloud outputs were not compared byte for byte.
- 500 MB at 8 MB per step: 62 steps, 627,726 rows, 490.2 MB in, 179 s in total. Step wall time p50 2.87 s, p95 3.60 s, max 3.67 s. R2 read p50 347 ms, R2 write p50 1.81 s.
- 5 GB at 8 MB per step, in two runs. The first ran about 23 minutes and stopped when the client's own 60 s timeout fired on one request, after more than 310 steps (the Worker had logged steps up to offset 2,666,263,790). Observability shows no slow step on the Worker side, so the stall was between the client and the Worker. The cause was not isolated, and a laptop on Wi-Fi is one candidate. The second run resumed from that offset with a retry on timeout (each step rewrites its own key, so a repeat is harmless) and finished: 296 steps, 3,020,981 rows, 2,359 MB in, 2,405 MB out, 836.7 s, step wall time p50 2.75 s, p95 3.56 s, max 4.30 s, no retries. The first run's totals were not written out because the driver died before it printed them, so the row count for the whole file is not known from the runs.
- CPU per step, from Workers Observability (`cpuTimeMs`), all runs together. 8 MB steps, n = 712 with outcome `ok`: p50 1.96 s, p95 2.80 s, max 3.44 s, wall time max 7.6 s. Other chunk sizes were tried in short runs (I did not record which dump): 4 MB (n = 14) p50 0.63 s; 16 MB (n = 4) p50 2.75 s; 32 MB (n = 2) 12.2 s of CPU and 20.5 s of wall time; 64 MB (n = 1) ended `exceededMemory` after 6.3 s. The ceiling is memory, between 32 and 64 MB for this conversion, and 8 MB leaves a wide margin on both memory and CPU. Local workerd does not enforce the isolate memory limit, so only these deployed runs say anything about it.
- Time. At 8 MB a step takes about 2.7 to 3.5 s, so one dump converts at about 3 MB/s on one chain: 500 MB in 3 minutes and 5 GB in about 37 minutes. Each step's start depends on the previous step's cut point, so the chain is sequential as written. Finding the cut points first would allow parallel steps, and that was not tried.
- This shows that CPU and memory per step stay flat as the dump grows from 50 MB to 5 GB, so a Worker handles the conversion and the limit is elapsed time. No size was found at which a Container has to take over. It does not show the landing of the converted SQL into a site, a Workflow running 614 steps (its step count limit was not checked), SSH streaming into R2 from a real server (only loopback rates exist, in the section above), dumps whose rows vary in size, or any dump producer other than `mysqldump`.

## Container jobs: start time, input transfer and a composer tree

Run on 2026-11-12 on the stage account. A standalone Worker (`drupflare-spike-containers`, deleted after the runs) fronts the `JobRunner` Durable Object from `engine/src/containers/`, with the `durable_object` scheduling policy (public beta) and the image from `engine/src/containers/image/Dockerfile` (amd64, 703 MB). Each run starts one instance, sends the input through the Worker, and destroys the instance. One client, from a laptop. Times come from the run record (`coldStartMs` is start until the health check answers, `wallMs` is start until `destroy()` returns).

- `echo-import` (standard-3, internet off, random bytes in, sha256 out), n = 4. 50 MB twice: cold start 650 and 919 ms, wall 3.7 and 3.9 s. 100 MB twice: cold start 655 and 588 ms, wall 7.7 and 10.5 s. The first run after the deploy, a 50 MB one, took a 9.95 s cold start and 12.8 s of wall time; it is not in the table because it came before the image had run once, and it was not repeated. Wall time grows with input size at roughly 75 to 105 ms per MB, which is the Worker-to-container transfer.
- `composer-tree` (standard-2, internet on), a project that requires Drupal core 11 (recommended), Drush 13, Pathauto, Token and Admin Toolbar, with no lock file, so composer resolves and downloads. n = 5 after the fixture was fixed: cold start 599 to 1,174 ms (median 1,061), wall 22.4, 24.9, 25.6, 32.9 and 33.5 s, input 464 bytes, output 26.1 MB. The same image run on this laptop under emulation, outside Cloudflare, also exited 0 with a 26.4 MB tarball.
- Five earlier `composer-tree` runs exited 1 after 5.8 to 12.6 s of wall time and are not part of the reading. My fixture did not allow the `symfony/runtime` plugin, and composer refused after downloading. The runner reported the failure as `job_failed` with exit code 1 each time, which is the behavior wanted, and the cause only showed in the container log from a local run of the same image. A deployed run record does not carry the container's output, so a failed job in production would say only "The job ran but did not finish".
- Cost, from the published rates already in the plan (derived, not billed): one `composer-tree` of 25 s on standard-2 is about $0.0009, against the $0.0086 the plan assumed for 240 s. The plan's duration was an assumption and this fixture ran ten times shorter. A tree with more packages, patches or a scaffold step will run longer.
- Credits. The balance read 999,958 cents before the series and 999,958 after (15 instances, 10 of them successful, about 4 minutes of instance time in total, near $0.01 by the published rates), so the reading neither shows nor rules out a draw. A second read after the 5 GB conversion above (about 690 R2 writes and 5 GB stored for an hour, all inside the free allowance) also gave 999,958. The billable-usage endpoint carries Container rows (vCPU, memory, disk, egress) as one row per service per day, and its latest day on the read was 2026-11-11, so today's runs were not in it yet. Whether Containers draw down the credit stays open until the 2026-11-12 rows appear.
- Not measured. A sleeping instance's billing (every run destroyed its instance), `template-build` and `drupal-hop` (the image exits 70, "not built"), a failed or timed-out job on the deployed path (the wall-limit alarm ran only against fakes), concurrent jobs, and an input above 100 MB (I kept to the front Worker's request body limit as I understood it and did not recheck the page, so there was no 500 MB `echo-import`). Cold starts are from one client and one colo.
