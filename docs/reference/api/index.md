---
title: API reference
description: The base path, how to read the interactive API page, and the conventions every endpoint shares.
audience: [developer]
type: written
draft: true
---

The API lives under `/api/v1`. Every endpoint returns JSON. Errors use the [error body](/docs/reference/api/errors).

## Start here

- [Authentication](/docs/reference/api/authentication) explains how to send a key or a session.
- [Rate limits](/docs/reference/api/rate-limits) lists the limits by route class (a group of endpoints that share a limit).
- [Idempotency](/docs/reference/api/idempotency) explains how to repeat a write safely.
- [Pagination](/docs/reference/api/pagination) explains list responses.
- [Webhooks](/docs/reference/api/webhooks) covers the events the platform sends and receives.
- [Status codes](/docs/reference/status-codes) lists every code.

## Interactive page and spec

The API page at `/api` shows every endpoint and lets you try them. The OpenAPI document it reads (the machine-readable description of the API) is at `/api/openapi.json`.

## Contract header

Send `Drupflare-Contract` with the range your client supports. See [contracts and versioning](/docs/reference/contracts-and-versioning).
