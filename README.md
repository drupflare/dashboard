# @drupflare/dashboard

> Drupflare control plane

The dashboard at `app.drupflare.com`. It manages Drupflare sites on managed, self-managed and self-hosted planes: accounts, organizations, sites, deploys, backups, billing and operations. Every action runs as a durable operation, and sites keep serving when the dashboard is down.

## Development

```sh
bun install
bun run dev
```

| Command                  | Runs                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `bun run typecheck`      | Type check with `vue-tsc`                                  |
| `bun run test:unit`      | Unit tests with Vitest                                     |
| `bun run test:bindings`  | Repository and service tests against local D1, KV and R2   |
| `bun run build`          | Production build for Cloudflare Workers                    |
| `bun run check:wrangler` | Confirms every binding in `wrangler.jsonc` is in the build |

Copy `.dev.vars.example` to `.dev.vars` for local secrets.

## License

Apache 2.0
