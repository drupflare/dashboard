---
title: Backups
description: Make a backup of a site's database, check that it restores, and download it.
audience: [solo-beginner, nonprofit]
type: written
draft: true
---

This page shows you how to make a backup and what it holds. It is for site owners.

A backup is a copy of a site's database at one moment. You make one from the site's Restore Points page.

## Make a backup

Open the site, go to Restore Points, and choose Back Up Now. The new backup appears in the list when it finishes.

The dashboard takes a backup when you ask for one. The dashboard does not show a backup schedule. Make a backup before a change you may need to undo.

## Check a backup

A backup is not verified when it is made. Choose Verify on the backup. The dashboard restores it into a scratch copy, checks that the copy answers, and removes the copy. Your live site is not touched. A backup that passes shows as verified.

Only a verified backup is a copy you can count on. See [restore a backup](/docs/guides/data/restore-a-backup).

## Download a backup

Choose Download on a backup to save it as one SQL file. The file holds no secrets. A download needs a fresh sign-in, and the download is recorded in the audit log.

## What a backup holds

The backup is the site database. Each restore point lists what it restores and what it does not. For point-in-time recovery, see [point-in-time recovery](/docs/guides/data/point-in-time-recovery).
