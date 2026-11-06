# Worker config fixtures

Copies of the Drupflare Worker's two deploy configs at commit `5d045fe3d9f638c3b3442af658f410179fe5b86a` on master, after v1.0.4 (tag commit `4cd73e1`). The managed config adds `CACHE_API`, `FILE_STORE` and a second bucket, `FILES_PRIVATE`, and both blobs are identical at `f7b3b18cce` and at this commit.

| File                     | Blob sha                                   | sha256 of the file                                                 |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| `wrangler.managed.jsonc` | `ccabfffae42e9257f1f3642275881958fa8de87a` | `ebf5d8b4bb9a6e93811b8830f41091687693906c5f14307cb42abace477804fa` |
| `wrangler.jsonc`         | `3feb1d3f4f321f18ee50d9c19b2938cd4d1679d2` | `ad4a8fa282da149ad3f992eabd5c0edb2306ca3a0fb30766f697614a5c106841` |

Refresh them from a new tag:

```sh
TAG=v1.0.4
git -C ../drupflare/worker show $TAG:wrangler.managed.jsonc > tests/unit/engine/fixtures/wrangler.managed.jsonc
git -C ../drupflare/worker show $TAG:wrangler.jsonc > tests/unit/engine/fixtures/wrangler.jsonc
```

Then update the commit and the hashes in this file. `descriptor.spec.ts` fails when a key in either file has no counterpart in `engine/src/descriptor.ts`, which is the signal to change the descriptor. The files parse as plain JSON, so the test reads them with `JSON.parse`; a refresh that adds comments needs a comment-aware parser.
