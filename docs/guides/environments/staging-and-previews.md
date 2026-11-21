---
title: Staging and previews
description: Make a staging, dev or preview copy of a site, what each copy keeps, and when it is deleted.
audience: [developer, agency]
type: written
draft: true
---

This page explains the three kinds of environment and what each is for. It is for site owners who want to test a change away from the live site.

An environment is a copy of a site, made from a backup. The original site is not changed. Three kinds exist: staging, dev and preview.

## Create an environment

Open the site, go to Environments, and choose Create Environment. Pick the kind, and for a preview pick how long it lives.

The copy is made from the site's newest restorable backup, or from a backup you name. It gets its own database, its own files and its own owner token.

Settings and secrets do not carry over. The dashboard lists them on the create form. Set them again on the copy.

## Preview lifetime

A preview is deleted on its own when its time runs out. The default is three days. The longest lifetime is 336 hours (14 days). A site can hold only a limited number of previews at once.

A staging or dev copy has no timer. It stays until you delete it.

## Delete an environment

Deleting an environment removes the copy and everything the platform made for it. The original site is not touched. An environment that is still being created or deleted cannot be deleted yet.

## Limits

- An environment copy is a snapshot from a backup. Changes made to the original after the backup do not appear in the copy.
- Moving changes from an environment back to the original is not available yet. See [promote changes](/docs/guides/environments/promote-changes).
- For who can open an environment, see [private sites and access](/docs/guides/environments/private-sites-and-access).
