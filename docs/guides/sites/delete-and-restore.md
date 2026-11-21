---
title: Delete a site
description: Delete a site, what happens to its address and backups, and why the dashboard cannot undo it.
audience: [solo-beginner]
type: written
draft: true
---

This page shows you how to delete a site and what happens to its address and backups. It is for site owners.

Deleting a site takes it off your list and stops it serving. The dashboard has no undo for a delete.

## What happens

Open the site, choose Delete Site, and type the site's name to confirm. The dashboard starts a delete operation and opens its progress page. The site stops serving once the operation takes it offline.

- Its address stays reserved for 90 days, so nobody else can claim it during that time.
- Its data is kept for those 90 days, and its backups are kept.
- You need a fresh sign-in to delete. If your sign-in is older, the dashboard asks you to confirm it first.
- You cannot start a delete while another change to the site is running. Wait for that change to finish.

For a site found on a self-hosted box, the delete removes the site from your list only. The site stays on the box and keeps serving.

## Restore a deleted site

Restoring a deleted site from the dashboard is not available yet. The dashboard has no route that brings back a deleted site or its address. The backups are kept after a delete, and the dashboard does not say for how long. See [restore a backup](/docs/guides/data/restore-a-backup) for what a backup restores into.

## Strata storage

A managed site that uses Strata has a private storage bucket (a container for files) for its history. Purging the site (removing what Drupflare made for it) revokes the bucket's access token and deletes the bucket. If the bucket still holds files, Cloudflare refuses the delete, so the bucket stays and the purge result names it. The rest of the purge finishes.
