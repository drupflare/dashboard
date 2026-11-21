---
title: Backup failed
description: What to check when a backup does not save, and how to run it again.
audience: [nonprofit, department-owner, developer, central-it]
type: written
draft: true
---

This page helps you read a failed backup and find its reason. It is for site owners.

A backup that fails shows the progress screen **Could Not Back Up the Site**, with the reason for the failure.

## Check the reason

Read the reason on the progress screen. Open the site's activity to see the same record later. The activity keeps each step, so you can see which one failed.

## Run it again

Start a new backup from the site's **Restore Points** page. A new backup does not depend on the failed one.

## What a backup holds

A backup holds the site database as it stood when the copy was taken. It does not hold uploaded files in separate file storage, or the site's secrets. See [backups and recovery](/docs/concepts/backups-and-recovery).

## When it keeps failing

Contact [support@drupflare.com](mailto:support@drupflare.com) with the site name, the time of the failed backup and its request id. Do not send the database or any secret.
