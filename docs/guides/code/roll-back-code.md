---
title: Roll back code
description: Return a site to an earlier code revision and check what the rollback can and cannot undo.
audience: [developer]
type: written
draft: true
---

This page shows you how to roll a site back to an earlier release. It is for site owners and admins.

Code History lists every release a site has run, newest first. Open it from the Code History button on the site page.

## Roll back

Choose Roll Back on an earlier release. The dashboard first checks whether that code can run on the data the site holds now. If it can, confirm and the code goes back. Your content and settings stay as they are.

If a later release changed the shape of the data in a way the earlier code cannot read, the dashboard refuses the roll back and says why. You then have two choices: restore the data together with the code, or fix the problem in a new release.

## What the list shows

The release running now is marked. A release that ran, was replaced and came back appears each time it ran, and only the newest of those rows is marked as running.

The list also holds edits delivered from the dashboard. Choose Roll Back on an edit that kept its files to send those files again. See Apply a patch. Edits made to a site by other means are not recorded.
