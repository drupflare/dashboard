---
title: Backups and recovery
description: The two ways to bring a site's data back, what each one restores, and what neither one covers.
audience: [developer, nonprofit, department-owner, central-it, security-reviewer]
type: written
draft: true
---

A site has two restore layers. They cover different things, so check which one you need before you restore.

## Backups

A backup is a copy of the site database, taken at one moment. Restoring a backup brings the database back to the moment the copy was taken.

A backup does not include uploaded files kept in separate file storage, or the secrets the site uses, such as the owner token and git access tokens. It also does not include anything changed after the copy was taken.

## Point-in-time recovery

Point-in-time recovery restores the site database and its stored key-value pairs to a moment you choose. The window is the last 30 days.

It has the same limits as a backup, and two more. It does not restore anything written after the chosen moment. It also does not help once the site itself is deleted, because its recovery history is kept with the site.

## Test a backup

A backup is not known to work until you restore it. Testing a backup restores it into a scratch copy and checks that the copy answers. Your live site is not touched, and the scratch copy is removed afterwards. A backup that passes reads as verified.

## Code rollback is separate

Rolling back code changes the code a site runs. It does not change the data. See [roll back code](/docs/guides/code/roll-back-code).

For the steps, see [backups](/docs/guides/data/backups), [restore a backup](/docs/guides/data/restore-a-backup) and [point-in-time recovery](/docs/guides/data/point-in-time-recovery).
