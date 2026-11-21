---
title: Restore a backup
description: Copy a backup into another site in your organization. The target site's content is replaced.
audience: [solo-beginner, nonprofit]
type: written
draft: true
---

This page shows you how to restore a backup into another site in your organization. It is for site owners.

Restoring a backup copies it into another site in your organization. The target site's content is replaced by the backup. This cannot be undone.

## Restore

1. Open the site that holds the backup and go to Restore Points.
2. Choose Restore on the backup.
3. Pick the target site from the list. The list shows the other sites in your organization.
4. Confirm the restore with Restore Backup.

The restore runs as an operation (one change to a site, with steps; see [operations](/docs/concepts/operations)). Check its progress page for the result.

If your organization has no other site, the dialog asks you to create one first.

## Before you restore

- Check that the target is the site you mean. Its content is replaced, and the change cannot be undone.
- Test the backup first if you have not restored it before. A verified backup has passed a test restore into a scratch copy. See [backups](/docs/guides/data/backups).
- A backup that is too large for a restore is refused.

## Restore to a moment instead

If you need the site as it stood at a time in the last 30 days, use point-in-time recovery. See [point-in-time recovery](/docs/guides/data/point-in-time-recovery).
