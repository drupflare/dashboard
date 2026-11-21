---
title: Rate limits
description: The request limits for each route class, the headers that report them, and what to do after a 429.
audience: [developer]
type: written
draft: true
---

Each endpoint belongs to one route class (a group of endpoints that share a limit). Each class has its own limit.

| Route class               | Limit          | Window     |
| ------------------------- | -------------- | ---------- |
| Read                      | 300 requests   | 1 minute   |
| Write                     | 60 requests    | 1 minute   |
| Heavy                     | 10 requests    | 1 minute   |
| Webhook                   | 1,000 requests | 1 minute   |
| Sign-in code              | 5 requests     | 10 minutes |
| Sign-in code, per address | 300 requests   | 10 minutes |
| Preflight                 | 10 requests    | 10 minutes |
| Preflight, platform-wide  | 200 requests   | 10 minutes |

These limits are placeholders until the plan limits are reviewed, so they can change. Each server keeps its own count, so the limit you see is per server.

## Headers

Every response carries:

- `RateLimit-Limit`: the limit for the class.
- `RateLimit-Remaining`: requests left in the window.
- `RateLimit-Reset`: seconds until the window frees a slot.

## After a 429

A `429` response has the `rate_limited` code and a `Retry-After` header, in seconds. Wait that long before you send the next request. Do not retry in a loop.

See [rate limited](/docs/troubleshooting/rate-limited) for what to check when a script keeps hitting the limit.
