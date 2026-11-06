# Dispatch Worker

Routes a hostname to a tenant script, and serves it only with a valid signed lease. It reads no control-plane state, so a control-plane outage does not stop it.

## Request path

1. `HOSTS_KV` maps the host to `{ v, siteId, script, epoch }`. The entry is a hint and authorizes nothing. A missing or malformed entry is a 404 with no `SITE_AUTH` call.
2. `admit.ts` checks a cached lease with `checkLease`. Lease mode serves from the cache and renews when a third of the life remains. Strict mode asks `SITE_AUTH` on every request and refuses when it is unreachable. Availability grace covers only an expired lease-mode lease whose state is not `suspended` or `revoked`.
3. `env.DISPATCH.get(script, {}, { limits })` runs the tenant. `cpuMs` and `subRequests` come from the lease `limits`.

Views go to Analytics Engine after the response, best effort.

## Durable Objects

- `SiteAuth`, one per site. `read()` returns the stored authority or `null`; the control plane picks its next generation from it. `lease()` and `renew()` issue signed leases. `apply()` takes a write signed by the control plane. It refuses a stale generation, a lower epoch, a bad signature and a message outside a five minute window. A revoked site gets no lease at the same epoch.
- `Names`, one per shard (`shardKey` in `src/shared/names.ts`). `reserve()` answers `reserved`, `held`, `taken`, `reserved-word` or `invalid`. `release()` takes an optional hold in milliseconds: a missing hold is the default of 90 days, zero frees the name at once, and a value below zero or above 365 days is clamped. A tombstoned name stays held.

- `UsageCounter`, one per site. `apply()` takes the view sequence ranges one isolate has acknowledged for an hour and counts only the part it has not seen, so a retry cannot double count. `read()` returns the counted hour. The serving path calls it only under the stage switch.

The decision logic is in `authority.ts`, `registry.ts` and `counting.ts`. The classes only read and write `ctx.storage.kv` around it.

## Control route

A POST to the host in `CONTROL_HOST` carries a signed write for `SiteAuth.apply`. No other host reaches it.

## Stage switch

The `stage` environment sets `SPIKE_MODE` to `1`. No other environment sets it, and without it the Worker counts nothing and has none of the routes below. A site is counted only when `HOSTS_KV` holds `mech:<siteId>` with `write-through`, `batched` or `hybrid`. Any other value, or no entry, leaves the site uncounted. Each isolate reads the entry once per site and keeps the answer.

A counted view is a 2xx `text/html` response. Write-through holds the response until the counter answers. The other two send in the background, and a timer under `waitUntil` flushes a small batch. The lease limit `viewsPerMonth` is the limit hybrid uses. A failed or slow counter never changes the response.

Two routes exist on `CONTROL_HOST` only. Each takes a POST whose body is signed with the control key under its own context, inside the same five minute window as a control write.

- `/__spike/evict` allocates memory until the isolate hits the 128 MB limit and is replaced. An isolate that survives answers with the size it reached.
- `/__spike/counts` returns `{ counts, hours }` for a site and a list of hour starts: the counter object's call statistics and the counted hour for each, or `null`.

Without the switch, both paths answer the same 404 as an unknown host. An unsigned, stale or wrongly signed request is refused before it reaches the counter.

## Secrets and variables

| Name                 | Holds                                         |
| -------------------- | --------------------------------------------- |
| `SITE_AUTH_SEED`     | base64url Ed25519 seed that signs leases      |
| `LEASE_PUBLIC_KEY`   | public key that verifies leases               |
| `CONTROL_PUBLIC_KEY` | public key that verifies control-plane writes |
| `CONTROL_HOST`       | host that accepts signed writes               |
| `SPIKE_MODE`         | `1` in the stage environment only             |

`HOSTS_KV` must be bound to the namespace the control plane writes. The binding in `wrangler.jsonc` has no id.

## Check

`bunx tsc -p dispatch/tsconfig.json`. Tests are in `tests/unit/dispatch`.
