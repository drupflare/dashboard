---
title: The Drupflare module
description: The Drupflare module that runs inside a Drupal site, what it adds to the site, and which pages it puts in the admin menu.
audience: [developer]
type: written
draft: true
---

This page explains the Drupflare module that runs inside a managed Drupal site. It is for site developers.

The Drupflare module runs inside a Drupal site on Drupflare. It replaces the parts of Drupal that need a compiled library on a server with Cloudflare services for mail, images, outbound HTTP, logging and request isolation. It needs Drupal core 11.3 or later.

## Pages it adds

The module adds these pages under the admin menu. Each one needs the permission shown.

- **Drupflare** (`/admin/config/drupflare`): the menu for the module's pages. Needs the status or site configuration permission.
- **Runtime Status** (`/admin/config/drupflare/status`): the site's runtime state. Needs the status or site configuration permission.
- **Runtime Settings** (`/admin/config/drupflare/settings`): the settings form. Needs the Drupflare site administration permission.
- **Code Delivery** (`/admin/modules/drupflare`): the module list for the site's code. Needs the Drupflare owner permission.
- **Operations Terminal** (`/admin/config/development/drupflare-ops`): an operations form for site administrators.

The module also finishes sign-in through Drupflare at `/drupflare/oidc/complete`.

## Including it in a template

Not available yet: this page does not describe how a template includes the module.
