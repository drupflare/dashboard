---
title: Security releases
description: How security advisories show up for a template and how a Drupflare release that answers one reaches sites.
audience: [developer, security-reviewer]
type: written
draft: true
---

This page explains how a security advisory reaches your site. It is for owners who track security updates.

A security advisory can reach your site in two places.

## Templates

The Create a Site page lists each Drupal template with the security advisories its Drupal core carries and the advisories from modules it includes. Update Drupal right after you create a site from such a template. See [Drupal and PHP updates](/docs/guides/upgrades/drupal-and-php-updates).

## Drupflare releases

Drupflare publishes a new release for the platform. The site's Release card shows Update Available when one is ready for the site. You apply it with Update, as described in [Drupal and PHP updates](/docs/guides/upgrades/drupal-and-php-updates).

The platform rolls a release out in rings (groups of sites that receive it in turn), not to every site at once. The [fleet rollouts](/docs/guides/upgrades/fleet-rollouts) page describes how a rollout moves between rings.
