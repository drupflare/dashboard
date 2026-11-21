---
title: Errors
description: The error body every failed API request returns, and how to read its fields.
audience: [developer]
type: written
draft: true
---

A failed request returns a JSON body with four fields:

```json
{
  "code": "validation",
  "message": "limit must be a positive integer",
  "details": null,
  "requestId": "req_..."
}
```

- `code` is one of the codes in [status codes](/docs/reference/status-codes). Branch on this field, not on `message`.
- `message` is a sentence for a person. Its wording can change between releases.
- `details` holds extra facts for some errors, such as the range a `426` response supports. It is `null` when there are none.
- `requestId` identifies the request. Include it in any support request.

Responses with a `Retry-After` header tell you how long to wait. This applies to `429` responses and to a write that is still running under the same idempotency key (the key that makes a repeated write safe).
