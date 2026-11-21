---
title: Migration plan template
description: A template for writing a site-by-site migration plan for an institution.
audience: [central-it]
type: written
draft: true
---

Copy this table into your planning document. One row per site.

| Site          | Department      | Site owner | Host today | Wave        | Preflight done | Cutover date | Rollback owner |
| ------------- | --------------- | ---------- | ---------- | ----------- | -------------- | ------------ | -------------- |
| Site hostname | Department name | Owner name | Host type  | Wave number | Yes or no      | Date         | Named person   |

Fill in one row per site before the first wave starts.

## Fields

- **Wave.** The group the site moves with. Keep each wave small enough to check by hand.
- **Preflight done.** Yes when you have run the preflight and read its findings. See [Preflight](/docs/guides/migration/preflight).
- **Cutover date.** The day the site moves. Set it only after the cutover action is available for your account. See [Cutover and rollback](/docs/guides/migration/cutover-and-rollback).
- **Rollback owner.** The person who makes the call to roll back. Name one person, not a team.

Add a section at the top for the sign-off: who approves each wave, and by when.
