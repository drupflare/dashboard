---
title: Status codes
description: The HTTP status codes the API returns, the error code that goes with each, and what each one means.
audience: [developer]
type: written
draft: true
---

Every error response uses the same body. It has four fields: `code`, `message`, `details` and `requestId`. Quote the `requestId` when you contact support.

| Status | Code                   | Meaning                                                                                                            |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 400    | `validation`           | The request is malformed or a value is invalid.                                                                    |
| 401    | `unauthenticated`      | No valid credential was sent.                                                                                      |
| 403    | `forbidden`            | The credential is valid but lacks the permission for this action.                                                  |
| 404    | `not_found`            | The resource does not exist, or you cannot see it.                                                                 |
| 409    | `conflict`             | The request clashes with the current state, such as a request with the same idempotency key that is still running. |
| 412    | `precondition_failed`  | A condition the request depends on does not hold.                                                                  |
| 422    | `unprocessable`        | The request is well formed but cannot be done.                                                                     |
| 426    | `contract_unsupported` | The client's contract range is outside the range the dashboard accepts.                                            |
| 429    | `rate_limited`         | The client sent too many requests. See [rate limits](/docs/reference/api/rate-limits).                             |
| 500    | `internal`             | Something failed on the server. Quote the request id.                                                              |
| 501    | `not_built`            | The feature is not available in this release.                                                                      |

See [errors](/docs/reference/api/errors) for the body shape and [contracts and versioning](/docs/reference/contracts-and-versioning) for the `426` response.
