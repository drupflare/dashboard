---
title: Idempotency
description: How the Idempotency-Key header makes a write safe to repeat, and what a replayed or pending response means.
audience: [developer]
type: written
draft: true
---

Write requests accept an `Idempotency-Key` header. Use it when a request might be sent twice, for example after a timeout (when the reply never arrived). The platform runs the write once and returns the same result to every repeat.

## The key

A key is 8 to 128 characters, made of letters, digits, `_` and `-`. Any other value returns `400`.

Use a new key for each new change. Reuse a key only to repeat the same request.

## Replayed responses

A repeat of a finished request returns the original status and body. The response carries `Idempotency-Replayed: true`.

If you send the same key with a different request, the platform refuses it. Keys are tied to the caller, the organization and the key text, so one caller's key does not collide with another's.

## Pending responses

If the first request is still running, a repeat returns `409` with `idempotency_pending` in `details`, and a `Retry-After` of 1 second. Wait, then send the request again.

A request that never finishes frees its key after two minutes.

## Keep records for a day

Completed responses are kept for 24 hours. A repeat after that is treated as a new request.
