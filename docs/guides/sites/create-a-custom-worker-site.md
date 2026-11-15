---
title: Create a custom Worker site
description: Create a site that runs your own Worker code instead of a Drupal template.
audience: [developer]
type: written
draft: false
---

You upload a built Worker as a `.tar.gz`. The platform reads it, tells you what it found, and creates a managed site that serves it. The bundle is read and never run during upload.

Your organization needs a plan that includes custom code. On the Free plan the upload is refused with a 403 and the answer names the plan that has it. Nothing is stored.

## What to upload

Build your project first. The archive holds your built files, not your source.

- `wrangler.jsonc` (or `wrangler.json`) at the top level of the archive. A wrapper folder around everything is removed.
- The entry file that `main` names, as built JavaScript. A `.ts` entry is refused.
- Any other built modules next to it.
- The folder that `assets.directory` names, if you serve static files.
- A `compatibility_date` in `YYYY-MM-DD` form that is not in the future.

The archive can be up to 16 MiB, unpack to 40 MiB, and hold 20,000 entries. Absolute paths, `..` paths and links are refused with a 422 and a reason.

## What the platform supports

Key-value namespaces, R2 buckets, D1 databases, email sending, stateful classes (with a `migrations` step that creates each one), plain-text `vars`, static assets, and compatibility flags carry over.

These are refused because the platform cannot verify them yet: `ai`, `containers`, `browser`, `hyperdrive`, `vectorize`, `tail_consumers`, queue consumers, service bindings, and any key it does not know. A stateful class with `script_name` or `environment` is refused because it would reach another script's data.

These are accepted and ignored, and the upload says so: `routes`, `env`, `limits` and `placement`. Schedules (`triggers.crons`) are accepted but do not run yet. D1 migration files are not applied, so a new database starts empty. Secrets are not supported. Put values that are safe to store in `vars`.

## Upload and create

Choose Bring Your Own on the Create a Site page, then pick the archive. The page lists each finding in plain words. A refused item says what to change in `wrangler.jsonc`. When nothing blocks the bundle, name the site and create it.

Over the API, `POST /api/v1/orgs/{orgId}/custom-bundles` takes the archive as the request body and returns a `bundleId` and the findings. Do not send an Idempotency-Key header. A bundle with a blocking finding is not stored and has a null `bundleId`. Uploading the same archive twice gives the same `bundleId`. A bundle belongs to the organization that uploaded it; another organization's `bundleId` is refused as unknown.

Create the site with `POST /api/v1/orgs/{orgId}/sites`, `kind` set to `custom`, and the `bundleId`.

## Update

Upload the new build, then `POST /api/v1/orgs/{orgId}/sites/{siteId}/bundle` with `{ "bundleId": "..." }` and an Idempotency-Key header. The site keeps serving while the engine uploads the bundle and checks the front page. If the check fails, the earlier bundle goes back.

An update keeps the stores the site already uses. It is refused with 422 and a reason when:

- the new bundle binds different key-value, bucket or database stores (`resources_changed`), or
- it removes or renames a stateful class the site stores data in, drops a migration step, or changes one the site already ran. Steps may only be added (`migration_refused`).

## Roll back

Each bundle the site has run is a revision. List them with the revisions route and put one back with the rollback route. A custom site rolls back to a bundle the same organization uploaded. The rollback swaps the code only; it does not restore data in your stores.

## Delete

Deleting a site removes the bundle files it was running once no other live site in the organization uses the same bundle.
