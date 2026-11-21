---
title: Measurements
description: Admin reference for the platform measurements and where each one is read.
audience: [developer]
type: written
draft: true
---

Admin screens show these platform measurements:

| Measurement                     | Where it is read                       |
| ------------------------------- | -------------------------------------- |
| Sites by state                  | Sites page at `/admin/sites`           |
| Credits, usage and headroom     | Capacity page at `/admin/capacity`     |
| Operations in flight and failed | Operations page at `/admin/operations` |
| Release rollouts                | Releases page at `/admin/releases`     |
| Abuse reports by state          | Abuse page at `/admin/abuse`           |

Two measurements are empty:

- Mail send counts. Nothing records sends yet, so the Mail page shows no budget or queue numbers.
- Notification activity on an organization. It shows as not recorded.

"In flight" counts operations that are running or verifying. Planned and awaiting-approval operations are not counted.
