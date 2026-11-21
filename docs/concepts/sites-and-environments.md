---
title: Sites and environments
description: What a site is, what an environment adds, and what happens to the live site when you delete one.
audience: [developer, agency, solo-beginner]
type: written
draft: true
---

A site is one Drupal or Worker app with one address. The address is a name on `drupflare.app` unless you attach your own domain.

An environment is a copy of a site, kept apart from the live site. Use one to test a change before it reaches visitors. You create an environment from the site's **Environments** page, and you can delete it there too.

Deleting an environment removes the copy and everything made for it. The live site is not touched.

A preview is a short-lived copy of the site, made from its newest backup. See [temporary previews](/docs/guides/code/temporary-previews) and [staging and previews](/docs/guides/environments/staging-and-previews).

## Site states

A site is active while it serves. A suspended site is held and does not serve. When you delete a site, its address is held for 90 days and its backups are kept. See [delete and restore](/docs/guides/sites/delete-and-restore).
