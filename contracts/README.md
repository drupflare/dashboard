# Contracts

This directory holds the public contracts of the Drupflare dashboard. They are zod 4 schemas in `src/`, JSON Schema generated from them in `json-schema/`, and signed test vectors in `vectors/`. The sibling repos (`bastion`, `worker`, the templates) build against a copy of this directory, so a contract change here is the only way a wire format changes.

`worker-requests.md` is the dashboard's own list of what it needs from `worker`. It stays here and is not synced.

## Contracts

| File                   | What it defines                                                               |
| ---------------------- | ----------------------------------------------------------------------------- |
| `common.ts`            | Prefixed ids, error envelope, cursor pages, canonical JSON, Ed25519, versions |
| `sites.ts`             | Site shape, planes, states and rings                                          |
| `operations.ts`        | Operation, step, plan digest, fencing epoch, change budget                    |
| `fleet-link.ts`        | Pairing, signed envelope, challenge, what leaves the box                      |
| `owner-assertion.ts`   | Short-lived signed assertion for one operation on one site                    |
| `site-auth.ts`         | Lease format, lease and strict modes, availability grace, renewal rule        |
| `discovery.ts`         | The `/.well-known/drupflare` document                                         |
| `releases.ts`          | Release manifest and release events                                           |
| `usage.ts`             | Hourly usage intervals, accuracy states, adjustments                          |
| `migration-cutover.ts` | Source-write policy, steps, rollback boundary                                 |
| `site-db-console.ts`   | Read-only site database console                                               |
| `templates.ts`         | `drupflare.template.json` for custom templates                                |
| `webhooks.ts`          | Outbound webhook payloads                                                     |

## Signing

Every signature is Ed25519 over UTF-8 bytes built as the signing context, a newline, and the canonical JSON of the message without its `sig` field. The context is a fixed string per contract (`drupflare.fleet-link.envelope.v1`, `drupflare.fleet-link.challenge.v1`, `drupflare.site-auth.lease.v1`, `drupflare.owner-assertion.v1`), so a signature made for one contract never verifies under another. Signatures are base64url without padding.

Canonical JSON sorts object keys by UTF-16 code unit, prints no whitespace, omits undefined object values, and refuses NaN and infinity. Key order on the wire does not matter. A signature computed over keys in written order does not verify, and the vectors include that case.

A verifier checks the signature over the raw received object, so a field added by a newer minor version stays covered. It then reads the fields it knows and ignores the rest.

## Vectors

`vectors/*.json` hold signed messages for the fleet link, site leases and owner assertions. Each file lists positive cases and negative cases. A negative case names the refusal code the verifier must return, and its `context` holds the verifier inputs (public key, current time, seen ids, expected site and epoch).

Vector keys are test keys. Each key carries a note saying so, and its seed is public on purpose. Never use these seeds outside tests. Positive cases include `signingInput`, the exact text that was signed, to help a second implementation find a mismatch.

A client in another language passes when it verifies every positive case and refuses every negative case with the listed code.

## Versioning

Each contract has a `{ major, minor }` version. The major version also appears in the `v` field of signed messages. A request names its range in the `Drupflare-Contract` header as `<contract>=<min>-<max>`, for example `fleet-link=1.0-1.2`. A node announces its range inside the signed challenge response.

Within a major version, changes are additive: new optional fields, new enum values a reader can ignore, new routes. Removing or renaming a field, tightening a type, or changing a signing rule needs a new major.

The dashboard accepts its current major and the previous one. The previous major stays accepted for at least two minor releases of the new major and at least 180 days, whichever ends later. A client outside that range gets `426` with the error envelope and the supported range in `details.supported`. Dropping an old major needs a deprecation notice in the docs and in the admin screen first.

`negotiate()` in `common.ts` implements this rule.

## Changing a contract

1. Edit the schema in `src/`.
2. Run `bun scripts/gen-contracts.ts`. It rewrites `json-schema/` and `vectors/` deterministically.
3. Run `bun run test:node`. A test fails when the committed generated files differ from the generator output.
4. Commit the schema and the generated files together.

## Syncing into a sibling repo

```sh
bun scripts/sync-contracts.ts ../bastion/contracts
```

The script copies `src/`, `json-schema/`, `vectors/` and this README into the target directory. It refuses a target outside the parent of the working directory unless you pass `--allow-outside`. It refuses to overwrite a file whose content differs unless you pass `--force`, and it writes nothing when it refuses.
