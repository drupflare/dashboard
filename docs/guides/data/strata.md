---
title: Strata
description: Use Strata to browse and restore a single field's history.
audience: [developer]
type: written
draft: true
---

This page explains the Strata add-on for Drupal sites. It is for owners who want a history of changes.

Strata is an optional add-on for Drupal sites. It keeps a history of changes in S3-compatible storage. It does not replace the platform backups.

## Turn it on

Open Modules for the site and choose Set Up Strata. Every managed plan includes it.

On the free plan, Strata writes its history into the database of the site, so it spends the same daily write allowance the site uses to serve pages. The dashboard shows a warning with the measured cost before it turns Strata on. You confirm once per site. In our measurement, the Light setting took about 27 percent of the write headroom a free site has for its own changes.

## How much it uses

Choose how much of the allowance Strata may use under How Much Strata May Use.

- Light records changes made through the site and saves history every 15 minutes. It is the default, and the only setting on the free plan.
- Detailed also records every database statement. It uses more of the allowance than Light, and it is available on paid plans.

History is saved on the site's 15 minute cycle with either setting. The dashboard keeps your choice, records each change in the audit log and sends it to the site. The screen says when the site has not accepted it. That happens when Strata is not turned on yet, when the site cannot be reached, or when the site has not been updated to accept the setting. Choose Try Again once that is fixed.

## Where the history lives

On a managed site, Strata keeps its history in a private bucket that Drupflare creates for that site. Turning Strata on does five things:

1. It turns on the S3 part of Strata.
2. It creates the bucket.
3. It makes an access token that can read and write that one bucket and nothing else.
4. It sends the token to the site.
5. It turns on Strata's history.

The site creates Strata's encryption key itself if it has none. Drupflare does not keep the token. Running the setup again replaces it.

A new token can take a few seconds before storage accepts it, so the first save of history may wait for the next 15 minute cycle.

If the storage could not be set up, the screen says so and gives the reason. Strata is on but is not saving history until the setup works. Choose Try Again to run it again. The usual cause is a site that has not been updated to accept the setting.

Each managed site that uses Strata has one access token.

On a self-managed site Strata stores where you point it, and the platform backups stay the default.

## When a site is purged

Purging a site revokes its token and deletes its bucket. Cloudflare refuses to delete a bucket that still holds objects, and Drupflare does not empty it. A bucket that still holds history stays in place, and the purge result lists it by name. Empty it in your Cloudflare account and purge the site again to remove it.
