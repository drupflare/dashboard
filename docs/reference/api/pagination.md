---
title: Pagination
description: How list endpoints return pages, how to request the next one, and the limits on page size.
audience: [developer]
type: written
draft: true
---

List endpoints return a page of items and a `nextCursor` value (a marker for the next page).

```json
{
  "items": [],
  "nextCursor": "eyJpZCI6InNpdGVfLi4uIn0"
}
```

## Requesting the next page

Send the `nextCursor` value back as the `cursor` query parameter. Stop when `nextCursor` is `null`.

Treat the cursor as opaque (it has no meaning you should rely on). Do not build one yourself or read fields from it. A broken cursor returns `400` with the message `Invalid cursor`.

## Page size

The `limit` parameter sets the number of items. It defaults to 25. The largest value is 100. A value above 100 is set to 100. A value that is not a positive whole number returns `400`.
