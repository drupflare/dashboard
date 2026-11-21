---
title: Template manifest
description: The fields of drupflare.template.json, a template manifest schema the dashboard does not read yet.
audience: [developer, agency]
type: written
draft: true
---

The platform contracts (the shared data formats) define a file named `drupflare.template.json` for custom templates. The dashboard does not read it yet. An uploaded Worker bundle is read from its Wrangler configuration instead, as [create a custom Worker site](/docs/guides/sites/create-a-custom-worker-site) describes. This page lists the fields of the schema as it is defined today, version 1 (`"v": 1`).

## Fields

| Field                | Type           | Rules                                                                                               |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `v`                  | number         | Must be `1`.                                                                                        |
| `slug`               | string         | Lowercase letters, digits and hyphens. Starts and ends with a letter or digit. Up to 64 characters. |
| `name`               | string         | 1 to 100 characters.                                                                                |
| `version`            | string         | 1 to 64 characters.                                                                                 |
| `description`        | string         | Up to 500 characters.                                                                               |
| `build.command`      | string or null | The command that builds the template. Null when no build runs.                                      |
| `build.output`       | string         | The directory the build writes. Required.                                                           |
| `entry`              | string         | The file the Worker starts from. Required.                                                          |
| `compatibilityDate`  | string         | `YYYY-MM-DD`.                                                                                       |
| `compatibilityFlags` | string array   | Compatibility flags for the Worker.                                                                 |
| `bindings`           | array          | See below.                                                                                          |
| `secrets`            | string array   | Secret names, in upper case with underscores.                                                       |
| `discovery`          | boolean        | Whether the template publishes a discovery document.                                                |

## Bindings

A binding is a connection to a storage service or another resource. Each binding has a `type` and a `name`. The name is upper case with digits and underscores, up to 64 characters.

The allowed binding types are `d1`, `kv`, `r2`, `durable_object`, `queue` and `ai`.

## Example

```json
{
  "v": 1,
  "slug": "campus-news",
  "name": "Campus News",
  "version": "1.0.0",
  "description": "A news section for a department site.",
  "build": { "command": "npm run build", "output": "dist" },
  "entry": "dist/index.js",
  "compatibilityDate": "2026-01-15",
  "compatibilityFlags": [],
  "bindings": [{ "type": "d1", "name": "NEWS_DB" }],
  "secrets": [],
  "discovery": false
}
```

See [make a template the dashboard can manage](/docs/guides/templates/make-a-template-the-dashboard-can-manage) and [discovery document](/docs/guides/templates/discovery-document).
