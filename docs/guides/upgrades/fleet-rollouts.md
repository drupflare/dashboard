---
title: Fleet rollouts
description: How Drupflare rolls a platform release out to every live site in rings, and when a rollout stops.
audience: [central-it]
type: written
draft: true
---

This page explains how a platform release reaches your sites in rings. It is for owners who want to know when a release arrives.

Drupflare runs fleet rollouts, and your organization does not start one. A rollout sends a release to every live site, one ring (a group of sites) at a time.

## How a rollout moves

- The next ring starts only when the ring before it reads clean.
- A bad reading stops the rollout, and the next ring never starts.
- A stopped rollout keeps the release on the rings that already received it.
- Only one rollout runs at a time. A new one is refused until the running one ends.

A rollout records the time from the security advisory to the last ring, when the release answers an advisory.

Your sites take a release through the site's Update action, described in [Drupal and PHP updates](/docs/guides/upgrades/drupal-and-php-updates). The rollout page is for platform administrators only.
