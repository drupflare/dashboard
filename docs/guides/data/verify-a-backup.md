---
title: Verify a backup
description: Check that a backup restores and boots before you rely on it.
audience: [department-owner, developer]
type: written
draft: true
---

This page shows you how to test a backup with a restore drill. It is for site owners.

## Test Restore

Test Restore restores a backup into a scratch site, checks that the copy boots and answers, and then removes the copy. Your live site is not touched. A backup counts as verified only after a test restore passes.

You can start one from the backup list. It uses the same operation as a manual run, so its result shows in Operations.

## Weekly Drills

The dashboard runs a test restore on its own. Each week it picks active sites whose newest backup has had no test restore in the last seven days and tests that backup. It starts one drill every 15 minutes across the whole platform, so a large estate finishes over a few days and no site is tested twice in a week.

A drill is skipped when the backup is larger than a restore accepts. It runs as one of the organization's owners, and the operation shows that name. A site whose organization has no owner is reported and skipped.

Each drill creates one scratch site and deletes it afterwards, and the restore writes the backup's rows into that site. We have not measured the account-wide API call volume of drills at scale, so the platform setting `RESTORE_DRILLS=off` turns them off without a deploy of code.
