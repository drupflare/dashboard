---
title: Temporary previews
description: Open a preview copy of a site that deletes itself after a set time.
audience: [developer]
type: written
draft: false
---

A preview is a copy of your site that deletes itself. Use one to try a change, or to show someone a version, without touching the live site.

## Make a preview

Open Environments for the site, choose Create Environment, pick Preview and choose how long to keep it: 1, 3, 7 or 14 days. The default is 3 days.

The copy starts from the newest backup of the site, so take a backup first if you want recent changes in it. Previews need a plan that includes environments. A site holds a limited number of previews at once, and the dialog tells you when you are at the limit.

Each preview gets the next free number, so the first is `your-site-preview-1`.

## What the copy has

The preview has its own database, files and owner token. Settings and secrets stay behind and must be set again on the copy. The Create dialog lists them.

## When it goes

The preview shows when it will be deleted. It is deleted within about 15 minutes of that time. To remove one sooner, choose Delete on its row. Deleting a preview never changes the live site.
