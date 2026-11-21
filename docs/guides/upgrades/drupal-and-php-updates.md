---
title: Drupal and PHP updates
description: What the dashboard updates on a site, which is the Drupflare release, and what you still update in Drupal and PHP yourself.
audience: [solo-beginner, developer]
type: written
draft: true
---

This page explains what the update action changes and what it leaves alone. It is for owners and admins who update a site.

The dashboard moves a site to the current Drupflare release. Drupal core and PHP updates are not part of that action.

## Update a site's release

When a newer release is available, the site's Release card shows Update Available and the release it runs. Choose Update, then Update Site.

The site keeps serving during the update, which takes several minutes. If the final check fails, the site returns to its old release on its own.

The update route is `POST /api/v1/orgs/{orgId}/sites/{id}/upgrade`. The platform picks the target release, so the request has no body. Send an Idempotency-Key header (see [idempotency key](/docs/start/glossary)). A repeat returns the same operation.

## Drupal core

When a template's Drupal core has open security advisories, the template list says so. It asks you to update Drupal right after you create the site.

How you update Drupal itself is not covered here.

## PHP

PHP updates are not covered here.
