# Engine Worker

The second Worker in this repo. Durable Objects, Workflows and Containers cannot be exported from the Nuxt server entry, so the code that runs site operations lives here. It reads and writes the same D1 database as the dashboard and imports only `@contracts/*` and relative files, never `src/server` or Nuxt.

It exports the `SiteLease` Durable Object and the `SiteCreate`, `SiteDelete`, `SitePurge`, `SiteCleanup`, `BackupCreate` and `BackupRestore` Workflows. Each class is thin: the decisions live in pure functions that take their state as an argument, and the classes only read and write storage around them.

## Modules

| File                              | Decides                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `src/descriptor.ts`               | The upload metadata for one site, from the managed or the canonical config          |
| `src/config-choice.ts`            | Which config an account gets, and the ordered steps to move a site between the two  |
| `src/provision-plan.ts`           | The per-site KV namespaces, bucket and database, their rollback order and a dry run |
| `src/operations/state.ts`         | Operation statuses, step moves, plan digest, blast radius and change budgets        |
| `src/operations/store.ts`         | The D1 store for operations, steps and site resources, with compare-and-swap writes |
| `src/lease.ts`                    | One writer per site: acquire, heartbeat, release and the fencing epoch              |
| `src/bundle.ts`                   | The release bundle manifest, its size and count gates, and asset chunking           |
| `src/ports.ts`                    | The interfaces the workflows call: Cloudflare, authority, names, site, releases     |
| `src/workflows/site-create.ts`    | Create steps and the rollback that undoes them                                      |
| `src/workflows/site-delete.ts`    | Delete (tombstone) and purge, which needs a second explicit confirmation            |
| `src/workflows/site-cleanup.ts`   | Removes what an unfinished create left behind; a retried create runs it first       |
| `src/backup-parts.ts`             | Backup ids, the part manifest with its sha256 digests, and the restore ceiling      |
| `src/workflows/backup-create.ts`  | Pages a site export into R2 parts and writes the manifest                           |
| `src/workflows/backup-restore.ts` | Checks the parts, restores them into a target site and waits for the replay         |

`scripts/build-bundle.ts` turns a `wrangler deploy --dry-run --outdir` directory into the bundle layout the release store reads. It does not run wrangler or upload.

`wrangler.jsonc` names bindings and carries no ids. Set the D1, KV and R2 ids at deploy time. Limits and the lease time come from vars (`LEASE_TTL_MS`, `ASSET_CHUNK_BYTES`, `LIMIT_MODULE_BYTES`, `LIMIT_TOTAL_BYTES`, `LIMIT_ASSET_BYTES`, `LIMIT_ASSETS`); the engine refuses to start without them.

## Check

`bunx tsc -p engine/tsconfig.json`. Tests are in `tests/unit/engine`. The fixtures there are the two Worker configs the descriptor has to match.

## Dry run

```sh
bun --tsconfig-override engine/tsconfig.json scripts/provision.ts \
  --site site_aaaaaaaaaaaaaaaa --config managed \
  --kv-limit 1000 --rate-limit 1200 --window-seconds 300
```

The limits come from the command line because Cloudflare changes them; read them from the current Cloudflare limits pages before you run it. The script prints the plan and calls nothing. `--apply` is refused.
