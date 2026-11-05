# Drupflare Dashboard

Nuxt 4 on Cloudflare Workers. Source in `src/` (`srcDir`), server in `src/server/`, shared code in `src/shared/`.

- `wrangler.jsonc` is the one hand-edited file for bindings that carry an id or a class. The `hub` block in `nuxt.config.ts` selects drivers and never repeats an id. `bun run check:wrangler` checks the built output.
- `wrangler.test.jsonc` is the vitest harness, not a deploy config.
- Durable Objects, Workflows and Containers cannot be exported from Nitro's entry (see `scripts/spikes/readings.md`), so they live in a second Worker in this repo.
- `@nuxt/content` builds with `experimental.nativeSqlite` (Node 24). Do not add `better-sqlite3`.
- `typescript` stays on 5.x because `vue-tsc` needs `typescript/lib/tsc`.
- A store cache is `Map<string, T | null>`: `undefined` is not loaded, `null` is known absent, an object is loaded.
