---
title: Managed settings and redirects
description: Change a site's settings on the Config page, read its change history, and see which Drupal admin paths redirect to the dashboard.
audience: [solo-beginner, developer]
type: written
draft: true
---

This page explains the settings groups on a site's Config page and what your role lets you see. It is for site owners and admins.

The Config page lists a site's settings in groups: Runtime, Content, Security, Integrations, Appearance and Access. You see only the groups your role can read.

## Change a setting

Edit a field and review the change before you apply it. Each field shows its current value. A field you cannot change shows the reason beside it. A field marked Danger needs its own confirmation before the change applies.

If someone else changes the site's settings after you opened the page, the save stops and shows the current values. Reload the page, check the new values, then make your change again.

Each change is written, read back and recorded in the Change History. To undo a change, choose Revert on its row in that history.

## Wrangler configuration

The Wrangler Configuration section shows the deploy settings from the site's configuration file. It is read only.

## Redirects

The Redirects table appears only when the site reports redirects. It lists Drupal admin paths, such as `/admin/config/drupflare`, and the dashboard page each one sends you to. The table is read only. You cannot add a redirect to a managed site from the dashboard.
