---
title: Point-in-time recovery
description: Return a site's stored data to a moment in the last 30 days. The restore applies the next time the site starts.
audience: [developer, department-owner]
type: written
draft: true
---

This page shows you how to return a site to an earlier moment in the last 30 days. It is for site owners.

Point-in-time recovery returns a site to how it stood at a moment you choose. The moment must fall in the last 30 days.

## Schedule a restore

1. Open the site and go to Restore Points.
2. Choose Restore to a Moment.
3. Pick a time inside the window and choose Schedule Restore.

The restore is scheduled, not instant. The site applies it the next time it starts.

## Undo a restore

When the restore is scheduled, the dashboard shows an undo point. Keep it. Use it to return the site to where it was before the restore.

## What it covers

Point-in-time recovery restores what the site stores. Code rollback is a separate step. See [roll back code](/docs/guides/code/roll-back-code).

To delete a site, see [delete a site](/docs/guides/sites/delete-and-restore).
