---
title: Rate limited
description: What a 429 response means, how long to wait, and how to keep a script inside the limits.
audience: [developer]
type: written
draft: true
---

This page helps you handle a `429` rate limit response from the API. It is for developers.

A `429` response with the code `rate_limited` means the client sent too many requests in a short time. The limit depends on the route class (the group of endpoints the call belongs to). See [rate limits](/docs/reference/api/rate-limits) for each one.

## Wait

The response has a `Retry-After` header that gives the number of seconds to wait. Wait that long, then send the request again.

The `RateLimit-Remaining` header on earlier responses shows how close you are to the limit.

## Keep a script inside the limit

- Slow the loop so it sends no more requests than the limit allows in one window.
- Read the `RateLimit-Reset` header and pause until it passes.
- Ask for up to 100 items per page with `limit`. Fewer pages mean fewer list calls. See [pagination](/docs/reference/api/pagination).
- Do not retry a write unless you send an `Idempotency-Key` header with it (a key that makes a retry return the first result). See [idempotency](/docs/reference/api/idempotency).

## Still limited

If the limit keeps coming back with no script running, check for another client that uses the same key. Then contact [support@drupflare.com](mailto:support@drupflare.com) with the request id from the response.
